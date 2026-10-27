/**
 * pi-use-db-helper 扩展入口（设计第 6 章）。
 * 职责装配：配置加载 → 启动甄别（延迟幂等）→ 每轮提示词注入 →
 * /pudh-set 命令（通道二）与 pudh_setup_connection 工具（通道一）→ 状态栏徽标 → 持久化。
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, configFilePath } from "./config.ts";
import { pickDatabaseMcpCandidates, shortToolName } from "./discover.ts";
import { DirectMcpClientGateway } from "./gateway.ts";
import { buildSection, SECTION_KEY } from "./inject.ts";
import { confirmSelection, pickOne, type PickerUI } from "./picker.ts";import {
  applyRestored,
  beginSelecting,
  buildStateData,
  cancelSelecting,
  commitSelection,
  initialState,
  isSelecting,
  restoreFromBranch,
  type PudhRuntimeState,
} from "./state.ts";
import { applyBadge } from "./status-badge.ts";
import { decideStage, entryNames, parseEntries, type SetupToolParams } from "./tool-protocol.ts";
import type { ConfigLoadResult, DiscoverCandidate, McpGateway, PudhConfig, PudhNamedEntry } from "./types.ts";

/** 扩展运行时单例状态（会话内共享）。 */
interface Runtime {
  configResult: ConfigLoadResult;
  state: PudhRuntimeState;
  /** 启动甄别挂起标志（首个有 UI 的 before_agent_start 幂等执行一次） */
  pendingBootstrap: boolean;
  /** 甄别是否已执行过（含零候选止步），防止重复执行 */
  bootstrapped: boolean;
  /** 通道二网关（按需创建，session_shutdown 释放） */
  channel2: DirectMcpClientGateway | undefined;
  /** 工具路径两阶段协议：阶段1 用户已选中的连接（阶段2 校验一致性） */
  pendingConnection: string | undefined;
  home: string | undefined;
}

const runtime: Runtime = {
  configResult: { config: { using_mcp_name: "", default_prompt: "", get_connection_tool_name: "", get_database_tool_name: "" }, status: "ok" },
  state: initialState(),
  pendingBootstrap: false,
  bootstrapped: false,
  channel2: undefined,
  pendingConnection: undefined,
  home: undefined,
};

/** 配置是否具备可运行条件（using_mcp_name 非空）。 */
function isConfigured(config: PudhConfig): boolean {
  return config.using_mcp_name !== "";
}

/** 会话启动：恢复状态 + 标记待甄别（4.3，决策 D9 不校验连接有效性）。 */
async function onSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  runtime.home = runtime.home ?? process.env.USERPROFILE ?? process.env.HOME;
  runtime.configResult = loadConfig(runtime.home);
  const restored = restoreFromBranch(ctx.sessionManager.getBranch());
  runtime.state = applyRestored(restored);
  applyBadge(ctx.ui, runtime.state.selection, runtime.state.phase);
  if (!isConfigured(runtime.configResult.config)) {
    runtime.pendingBootstrap = true;
  }
  void pi;
}

/** 通用picker UI 适配。 */
function asPickerUI(ctx: ExtensionContext): PickerUI {
  return {
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    custom: ctx.mode === "tui" ? (factory) => ctx.ui.custom(factory) : undefined,
    select: (title, options) => ctx.ui.select(title, options),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}

/** 甄别候选 → 用户选择（多候选 5#）。零候选时 notify 后返回 undefined。 */
async function resolveCandidate(ui: PickerUI, candidates: DiscoverCandidate[]): Promise<DiscoverCandidate | undefined> {
  if (candidates.length === 0) {
    ui.notify?.("无法使用 pi-use-db-helper，因为 MCP 无法提供获取数据库连接和 database 的途径", "warning");
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const picked = await pickOne(ui, "检测到多个数据库 MCP，请选择", candidates.map((candidate) => candidate.server));
  if (picked === undefined) {
    return undefined;
  }
  return candidates.find((candidate) => candidate.server === picked);
}

/**
 * 执行甄别（5.1）：回填配置并写盘。返回是否已具备可运行配置。
 * - 自动触发（before_agent_start）：幂等一次，零候选止步不再重试；
 * - 强制触发（force，命令/工具路径按需自举）：即使已止步也重新甄别（覆盖 MCP 晚连接的时序场景）。
 */
async function runBootstrap(pi: ExtensionAPI, ui: PickerUI, force = false): Promise<boolean> {
  if (isConfigured(runtime.configResult.config)) {
    runtime.bootstrapped = true;
    runtime.pendingBootstrap = false;
    return true;
  }
  if (runtime.bootstrapped && !force) {
    return false;
  }
  const tools = pi.getAllTools().map((tool) => ({
    name: tool.name,
    namespace: tool.namespace?.name,
    description: tool.description,
  }));
  const candidates = pickDatabaseMcpCandidates(tools);
  const chosen = await resolveCandidate(ui, candidates);
  if (chosen === undefined) {
    if (!force) {
      runtime.bootstrapped = true;
      runtime.pendingBootstrap = false;
    }
    return false;
  }
  const config = runtime.configResult.config;
  config.using_mcp_name = chosen.server;
  config.get_connection_tool_name = shortToolName(chosen.connectionTool);
  config.get_database_tool_name = shortToolName(chosen.databaseTool);
  saveConfig(config, runtime.home);
  runtime.bootstrapped = true;
  runtime.pendingBootstrap = false;
  return true;
}

/** 通道二网关（命令路径专用，按需重建）。 */
function buildChannel2(ctx: ExtensionContext): DirectMcpClientGateway {
  if (runtime.channel2 !== undefined) {
    return runtime.channel2;
  }
  const config = runtime.configResult.config;
  runtime.channel2 = new DirectMcpClientGateway(
    ctx.cwd,
    config.using_mcp_name,
    config.get_connection_tool_name,
    config.get_database_tool_name,
    runtime.home,
    {
      onAuthorizationUrl: (url) => {
        ctx.ui.notify(`请在浏览器中完成 MCP OAuth 授权：${url}`, "info");
      },
    },
  );
  return runtime.channel2;
}

/** 命令路径选择编排（通道二直连）：连接层 → database 层 → 二次确认。 */
async function runSelectionFlow(
  ui: PickerUI,
  gateway: McpGateway,
): Promise<{ ok: true; connection: string; database: string } | { ok: false; reason: "cancelled" } | { ok: false; reason: "error"; message: string }> {
  const connections = await gateway.listConnections();
  if (connections.length === 0) {
    return { ok: false, reason: "error", message: "该 MCP 下没有可用连接" };
  }
  const connection = await pickOne(ui, "选择数据库连接", connections);
  if (connection === undefined) {
    return { ok: false, reason: "cancelled" };
  }
  const databases = await gateway.listDatabases(connection);
  if (databases.length === 0) {
    return { ok: false, reason: "error", message: `连接 ${connection} 下没有 database` };
  }
  const database = await pickOne(ui, `选择 database（连接：${connection}）`, databases);
  if (database === undefined) {
    return { ok: false, reason: "cancelled" };
  }
  const confirmed = await confirmSelection(ui, connection, database);
  if (!confirmed) {
    return { ok: false, reason: "cancelled" };
  }
  return { ok: true, connection, database };
}

/** 写入选择结果：状态机提交 + 持久化 + 状态栏刷新。 */
function commitResult(pi: ExtensionAPI, ctx: ExtensionContext, connection: string, database: string): void {
  runtime.state = commitSelection(runtime.state, connection, database);
  runtime.pendingConnection = undefined;
  pi.appendEntry("pudh_state", buildStateData(runtime.state.selection));
  applyBadge(ctx.ui, runtime.state.selection, runtime.state.phase);
}

/** 工具结果文本构造器。 */
function toolText(message: string, isError = false): { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean } {
  return { content: [{ type: "text", text: message }], details: undefined, isError };
}

/** 阶段1：用 agent 转换后的连接条目渲染选择器；返回下一步指引。 */
async function runToolStage1(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  entries: PudhNamedEntry[],
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
  const config = runtime.configResult.config;
  const connection = await pickOne(asPickerUI(ctx), "选择数据库连接", entryNames(entries));
  if (connection === undefined) {
    runtime.state = cancelSelecting(runtime.state);
    runtime.pendingConnection = undefined;
    applyBadge(ctx.ui, runtime.state.selection, runtime.state.phase);
    return toolText("用户未选择连接", true);
  }
  runtime.pendingConnection = connection;
  const dbToolHint = config.get_database_tool_name !== "" ? config.get_database_tool_name : "目标 MCP 的 database 列表工具";
  return toolText(
    `已选择连接：${connection}。\n` +
      `请调用 ${dbToolHint}（参数 connection_name: "${connection}"）查询该连接的 database 列表，` +
      `将输出转换为标准格式 [{"order":1,"name":"数据库名"}]，` +
      `然后再次调用本工具，传入参数 {"connection":"${connection}","databases":[...]}。`,
  );
}

/** 阶段2：用 agent 转换后的 database 条目渲染选择器，确认后提交。 */
async function runToolStage2(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  connection: string,
  entries: PudhNamedEntry[],
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
  const config = runtime.configResult.config;
  const database = await pickOne(asPickerUI(ctx), `选择 database（连接：${connection}）`, entryNames(entries));
  if (database === undefined) {
    runtime.state = cancelSelecting(runtime.state);
    runtime.pendingConnection = undefined;
    applyBadge(ctx.ui, runtime.state.selection, runtime.state.phase);
    return toolText("用户未选择连接", true);
  }
  const confirmed = await confirmSelection(asPickerUI(ctx), connection, database);
  if (!confirmed) {
    runtime.state = cancelSelecting(runtime.state);
    runtime.pendingConnection = undefined;
    applyBadge(ctx.ui, runtime.state.selection, runtime.state.phase);
    return toolText("用户未确认选择", true);
  }
  commitResult(pi, ctx, connection, database);
  return toolText(
    `已设置数据库连接：${connection}，database：${database}。` +
      `后续使用 ${config.using_mcp_name} 的工具时请显式指定该连接与 database。`,
  );
}

/** 工具 execute 主体（5.3，两阶段协议：数据由 agent 转换后传入）。 */
async function executeSetupTool(
  pi: ExtensionAPI,
  _toolCallId: string,
  ctx: ExtensionToolContext,
  params: SetupToolParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
  const config = runtime.configResult.config;
  if (!isConfigured(config)) {
    // 按需自举：工具调用可能先于首轮对话发生，此时自动甄别尚未执行（8#15 挂起重试的兑底）
    const ready = await runBootstrap(pi, asPickerUI(ctx), true);
    if (!ready) {
      return toolText("pi-use-db-helper 未发现可用的数据库 MCP（需提供获取连接与 database 列表的工具）", true);
    }
  }
  if (!ctx.hasUI) {
    return toolText("当前模式无 UI，请在交互模式（TUI）中操作", true);
  }
  const stage = decideStage(params);
  if (stage === "invalid") {
    return toolText(
      "参数缺失。请先用目标 MCP 的连接列表工具查询连接，将输出转换为 [{\"order\":1,\"name\":\"连接名\"}] 格式，" +
        "以参数 connections 传入本工具（两阶段协议的第 1 次调用）。",
      true,
    );
  }
  if (stage === "stage1") {
    const entries = parseEntries(params.connections);
    if (entries === null) {
      return toolText('connections 格式非法：需为非空数组 [{"order":1,"name":"连接名"}]，请将查询输出转换后重传', true);
    }
    if (isSelecting(runtime.state)) {
      return toolText("选择已在进行中，请稍后");
    }
    const pending = beginSelecting(runtime.state);
    if (pending === null) {
      return toolText("选择已在进行中，请稍后");
    }
    runtime.state = pending;
    runtime.pendingConnection = undefined;
    return runToolStage1(pi, ctx, entries);
  }
  // 阶段2
  const entries = parseEntries(params.databases);
  if (entries === null) {
    return toolText('databases 格式非法：需为非空数组 [{"order":1,"name":"数据库名"}]，请将查询输出转换后重传', true);
  }
  const stage2Connection = params.connection as string;
  if (!isSelecting(runtime.state)) {
    return toolText(`尚未开始选择流程：请先传入 connections 参数完成第 1 次调用`, true);
  }
  if (runtime.pendingConnection !== stage2Connection) {
    return toolText(
      `connection "${stage2Connection}" 与第 1 次调用选中的连接 "${runtime.pendingConnection ?? "(无)"}" 不一致，请按返回指引重试`,
      true,
    );
  }
  return runToolStage2(pi, ctx, stage2Connection, entries);
}

/** /pudh-set 命令主体（5.2，走通道二）。 */
async function executePudhSetCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const config = runtime.configResult.config;
  if (!isConfigured(config)) {
    // 按需自举：命令可在首轮对话前使用，此时自动甄别尚未执行
    const ready = await runBootstrap(pi, asPickerUI(ctx), true);
    if (!ready) {
      return; // 零候选/用户取消时 resolveCandidate 已 notify 或用户主动退出
    }
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("当前模式无 UI，请在交互模式运行 /pudh-set", "warning");
    return;
  }
  if (isSelecting(runtime.state)) {
    ctx.ui.notify("选择已在进行中", "info");
    return;
  }
  const gateway = buildChannel2(ctx);
  const ready = await gateway.checkReady();
  if (!ready.ok) {
    ctx.ui.notify(`无法直连 MCP，请直接让 agent 设置数据库连接（原因：${ready.reason ?? "未知"}）`, "warning");
    return;
  }
  const pending = beginSelecting(runtime.state);
  if (pending === null) {
    ctx.ui.notify("选择已在进行中", "info");
    return;
  }
  runtime.state = pending;
  const outcome = await runSelectionFlow(asPickerUI(ctx), gateway);
  if (!outcome.ok) {
    runtime.state = cancelSelecting(runtime.state);
    applyBadge(ctx.ui, runtime.state.selection, runtime.state.phase);
    // 决策 D4：命令路径取消/失败静默返回（错误场景 gateway 已抛出具体文案的场景除外）
    if (outcome.reason === "error") {
      ctx.ui.notify(outcome.message, "warning");
    }
    return;
  }
  commitResult(pi, ctx, outcome.connection, outcome.database);
  ctx.ui.notify(`已设置数据库连接：${outcome.connection}，database：${outcome.database}`, "info");
}

/** 会话关闭：释放通道二与互斥状态。 */
async function onSessionShutdown(): Promise<void> {
  if (runtime.channel2 !== undefined) {
    await runtime.channel2.dispose();
    runtime.channel2 = undefined;
  }
  runtime.state = initialState();
  runtime.pendingConnection = undefined;
}

/** MCP 集合变化：仅重置通道二（下次按需重建），不做主动校验（决策 D9）。 */
async function onMcpServersChange(): Promise<void> {
  if (runtime.channel2 !== undefined) {
    await runtime.channel2.dispose();
    runtime.channel2 = undefined;
  }
}

/** 扩展工厂入口。 */
export default function piUseDbHelper(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await onSessionStart(pi, ctx);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (runtime.pendingBootstrap && ctx.hasUI) {
      await runBootstrap(pi, asPickerUI(ctx));
    }
    const config = runtime.configResult.config;
    if (!isConfigured(config)) {
      return;
    }
    const section = buildSection(config, runtime.state.selection.connection, runtime.state.selection.database);
    event.systemPromptOptions.sections[SECTION_KEY] = section;
  });

  pi.registerTool({
    name: "pudh_setup_connection",
    label: "选择数据库连接",
    description:
      "会话任务涉及数据库且尚未确定连接/database 时必须先调用本工具；打开交互式选择器由用户选择。" +
      "两阶段调用协议（工具原始输出由你转换为标准 JSON 后传入）：\n" +
      '第 1 次调用：先用目标 MCP 的连接列表工具查询连接，将输出转换为 [{"order":1,"name":"连接名"}]，以参数 connections 传入；\n' +
      "选择器由用户操作，返回结果会指明下一步；\n" +
      '第 2 次调用：按返回指引查询该连接的 database 列表，转换为 [{"order":1,"name":"数据库名"}]，连同选中的 connection 传入；' +
      "用户选择并确认后设置完成。",
    parameters: Type.Object({
      connections: Type.Optional(Type.Array(Type.Object({ order: Type.Number(), name: Type.String() }))),
      connection: Type.Optional(Type.String()),
      databases: Type.Optional(Type.Array(Type.Object({ order: Type.Number(), name: Type.String() }))),
    }),
    exposure: "model-only",
    execute: async (
      toolCallId: string,
      params: { connections?: Array<{ order: number; name: string }>; connection?: string; databases?: Array<{ order: number; name: string }> },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) => {
      return executeSetupTool(pi, toolCallId, ctx, params);
    },
  });

  pi.registerCommand("pudh-set", {
    description: "设置数据库连接与 database（pi-use-db-helper）",
    handler: async (_args: string, ctx) => {
      await executePudhSetCommand(pi, ctx);
    },
  });

  pi.on("mcp_servers_change", async () => {
    await onMcpServersChange();
  });

  pi.on("session_shutdown", async () => {
    await onSessionShutdown();
  });
}

// 供调试：暴露当前配置文件路径
export { configFilePath };

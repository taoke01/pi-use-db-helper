/**
 * MCP 网关（决策 D10）。
 * 工具路径已改为 agent 介入转换协议（5.3，数据由 agent 以标准 JSON 传入），不再需要通道一；
 * 通道二 DirectMcpClientGateway：/pudh-set 命令路径，自持轻量 MCP client 直调（无 agent 参与，
 * 由增强版 parseNameList 直接解析原始输出）；stdio 使用 MCP SDK，HTTP 使用 pi-mcp，
 * 支持 OAuth 浏览器授权、持久化令牌与刷新。其他连接失败仍由 checkReady 返回原因。
 */
import type { McpGateway, McpServerEntry } from "./types.ts";
import { findServerConfig } from "./mcp-config.ts";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { HttpOAuthSession } from "./oauth.ts";

/** 通道二 client 空闲自动关闭时长（毫秒）。 */
export const IDLE_CLOSE_MS = 60_000;

/** executeTool / MCP SDK callTool 结果的结构子集（两者形状兼容适配）。 */
export interface ToolOutcomeLike {
  isError?: boolean;
  /** MCP SDK callTool 形状：content 在顶层 */
  content?: Array<{ type?: string; text?: string }>;
  /** pi executeTool 形状：content 包在 result 内 */
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
}

/** 解析器输入：文本内容聚合（同时兼容顶层 content 与 result.content 两种形状）。 */
export function aggregateText(outcome: ToolOutcomeLike): string {
  const parts: string[] = [];
  const collect = (content: unknown): void => {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === "string") {
          parts.push(block.text);
        }
      }
    }
  };
  collect(outcome.content);
  collect(outcome.result?.content);
  return parts.join("\n");
}

/** 从 JSON 值中递归提取字符串列表（兼容 data/results/items 等包裹字段）。 */
function extractStringList(value: unknown, depth: number = 0): string[] | undefined {
  if (depth > 3) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        items.push(item);
      } else if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const name = obj.name ?? obj.connection ?? obj.database ?? obj.id;
        if (typeof name === "string") {
          items.push(name);
        }
      }
    }
    return items;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of ["data", "results", "items", "connections", "databases", "list"]) {
      if (key in obj) {
        const nested = extractStringList(obj[key], depth + 1);
        if (nested !== undefined && nested.length > 0) {
          return nested;
        }
      }
    }
  }
  return undefined;
}

/**
 * 工具返回文本 → 名称列表（8#11 容错）：
 * 1. JSON 优先：数组或对象包裹均提取；
 * 2. Markdown 表格：提取表头 Name 列（如 dbx_list_connections 的返回）；
 * 3. Markdown 无序列表：剥离 "- " / "* " 前缀（如 dbx_list_databases 的返回）；
 * 4. 兜底：按行拆分，去空行与常见装饰行（如 "---"）。
 */
export function parseNameList(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  try {
    const json = JSON.parse(trimmed) as unknown;
    const list = extractStringList(json);
    if (list !== undefined) {
      return list;
    }
  } catch {
    // 非 JSON，继续尝试 Markdown 形态
  }
  const tableNames = parseMarkdownTableNameColumn(trimmed);
  if (tableNames !== null) {
    return tableNames;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "---" && !/^-+$/.test(line))
    .map((line) => line.replace(/^[*-]\s+/, ""))
    .filter((line) => line !== "");
  return lines;
}

/**
 * Markdown 表格解析：定位表头中的 Name 列，提取数据行该列的值。
 * 仅当存在表头 Name 列与分隔行时生效；无数据行返回空数组（表存在但无数据）。
 * 非表格文本返回 null（交给后续兜底）。
 */
function parseMarkdownTableNameColumn(text: string): string[] | null {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (rows.length < 2) {
    return null;
  }
  const cells = (row: string): string[] =>
    row
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  const header = cells(rows[0]);
  const nameIndex = header.findIndex((cell) => /^name$/i.test(cell) || /^(连接名|名称)$/.test(cell));
  if (nameIndex === -1) {
    return null;
  }
  const separatorIndex = rows.findIndex((row, index) => index > 0 && /^\|[\s:|-]+\|$/.test(row));
  if (separatorIndex === -1) {
    return null;
  }
  const names: string[] = [];
  for (let i = separatorIndex + 1; i < rows.length; i++) {
    const value = cells(rows[i])[nameIndex];
    if (value !== undefined && value !== "") {
      names.push(value);
    }
  }
  return names;
}

/** 从 executeTool 结果解析名称列表；isError 上抛语义由调用方处理（返回 null）。 */
export function parseOutcomeNames(outcome: ToolOutcomeLike): string[] | null {
  if (outcome.isError === true || outcome.result?.isError === true) {
    return null;
  }
  return parseNameList(aggregateText(outcome));
}

/** 工具名解析（通道二）：MCP server 只认短名，剥离 pi 侧的 mcp__<server>__ 包装。 */
export function resolveShortToolName(configuredName: string): string {
  if (!configuredName.startsWith("mcp__")) {
    return configuredName;
  }
  const withoutPrefix = configuredName.slice("mcp__".length);
  const idx = withoutPrefix.indexOf("__");
  if (idx === -1) {
    return withoutPrefix;
  }
  return withoutPrefix.slice(idx + 2);
}

/** 两种 MCP client 的统一最小类型面。 */
interface MinimalMcpClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface DirectMcpGatewayOptions {
  onAuthorizationUrl?: (url: string) => void;
  openUrl?: (url: string) => void | Promise<void>;
  oauthCallbackTimeoutMs?: number;
}

function hasStaticAuthorization(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization");
}

function isOAuthAuthorizationRequired(error: unknown): boolean {
  return (
    error instanceof McpOAuthAuthorizationRequiredError ||
    (error instanceof Error && error.name === "McpOAuthAuthorizationRequiredError")
  );
}

/** 通道二网关：/pudh-set 命令路径专用（决策 D10 通道二）。 */
export class DirectMcpClientGateway implements McpGateway {
  private client: MinimalMcpClient | undefined;
  private oauthSession: HttpOAuthSession | undefined;
  private connecting: Promise<MinimalMcpClient> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly serverName: string,
    /** 两个工具名以通道二实际调用为准：构造时统一转为 server 侧短名 */
    private readonly connectionToolName: string,
    private readonly databaseToolName: string,
    private readonly home?: string,
    private readonly options: DirectMcpGatewayOptions = {},
  ) {
    this.connectionShortName = resolveShortToolName(connectionToolName);
    this.databaseShortName = resolveShortToolName(databaseToolName);
  }

  private readonly connectionShortName: string;
  private readonly databaseShortName: string;

  private serverConfig(): McpServerEntry {
    const config = findServerConfig(this.cwd, this.serverName, this.home);
    if (config === undefined) {
      throw new Error(`mcp.json 中未找到 server：${this.serverName}`);
    }
    return config;
  }

  private async connectHttp(config: McpServerEntry, oauthSession?: HttpOAuthSession): Promise<MinimalMcpClient> {
    if (typeof config.url !== "string" || config.url === "") {
      throw new Error(`server ${this.serverName} 的 http 配置缺少 url`);
    }
    const raw = new McpClient({ name: "pi-use-db-helper", version: "1.0.0" });
    try {
      await raw.connect(
        new StreamableHttpTransport({
          url: config.url,
          headers: config.headers,
          authProvider: oauthSession?.authProvider,
        }),
      );
    } catch (error) {
      await raw.close().catch(() => undefined);
      throw error;
    }
    return {
      listTools: async () => ({ tools: await raw.listTools() }),
      callTool: (args) => raw.callTool(args.name, args.arguments),
      close: () => raw.close(),
    };
  }

  private async connectStdio(config: McpServerEntry): Promise<MinimalMcpClient> {
    if (typeof config.command !== "string" || config.command === "") {
      throw new Error(`server ${this.serverName} 配置缺少 command`);
    }
    let sdk: typeof import("@modelcontextprotocol/sdk/client/index.js");
    try {
      sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    } catch {
      throw new Error("未安装 @modelcontextprotocol/sdk，无法直连 stdio MCP");
    }
    const stdioModule = (await import("@modelcontextprotocol/sdk/client/stdio.js")) as unknown as {
      StdioClientTransport: new (opts: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
      }) => unknown;
    };
    const client = new sdk.Client({ name: "pi-use-db-helper", version: "1.0.0" }) as unknown as MinimalMcpClient & {
      connect(transport: unknown): Promise<void>;
    };
    await client.connect(
      new stdioModule.StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      }),
    );
    return client;
  }

  /** 建立自持 client；HTTP OAuth 首次授权后直接重连，不经过 agent。 */
  private async ensureClient(): Promise<MinimalMcpClient> {
    if (this.disposed) {
      throw new Error("通道二 client 已释放");
    }
    if (this.client !== undefined) {
      return this.client;
    }
    if (this.connecting !== undefined) {
      return this.connecting;
    }
    this.connecting = (async () => {
      const config = this.serverConfig();
      const isHttp = config.type === "http" || (typeof config.url === "string" && config.url !== "" && config.command === undefined);
      if (!isHttp) {
        const client = await this.connectStdio(config);
        this.client = client;
        this.scheduleIdleClose();
        return client;
      }

      // 与 pi 一致：显式 Authorization header 使用静态认证，不再叠加 OAuth。
      if (hasStaticAuthorization(config.headers)) {
        const client = await this.connectHttp(config);
        this.client = client;
        this.scheduleIdleClose();
        return client;
      }

      const session = await HttpOAuthSession.create({
        serverName: this.serverName,
        serverUrl: config.url as string,
        oauth: config.oauth,
        home: this.home,
        onAuthorizationUrl: this.options.onAuthorizationUrl,
        openUrl: this.options.openUrl,
        callbackTimeoutMs: this.options.oauthCallbackTimeoutMs,
      });
      try {
        let client: MinimalMcpClient;
        try {
          client = await this.connectHttp(config, session);
        } catch (error) {
          if (!isOAuthAuthorizationRequired(error)) {
            throw error;
          }
          await session.completeAuthorization();
          client = await this.connectHttp(config, session);
        }
        this.oauthSession = session;
        this.client = client;
        this.scheduleIdleClose();
        return client;
      } catch (error) {
        await session.close().catch(() => undefined);
        throw error;
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** 已连接期间令牌失效且刷新失败时，重新授权并重放一次原操作。 */
  private async withClient<T>(operation: (client: MinimalMcpClient) => Promise<T>): Promise<T> {
    const client = await this.ensureClient();
    try {
      const result = await operation(client);
      this.scheduleIdleClose();
      return result;
    } catch (error) {
      const session = this.oauthSession;
      if (!isOAuthAuthorizationRequired(error) || session === undefined) {
        throw error;
      }
      await this.closeConnectedClient();
      try {
        await session.completeAuthorization();
        const reconnected = await this.connectHttp(this.serverConfig(), session);
        this.client = reconnected;
        const result = await operation(reconnected);
        this.scheduleIdleClose();
        return result;
      } catch (retryError) {
        if (this.oauthSession === session) {
          this.oauthSession = undefined;
        }
        await session.close().catch(() => undefined);
        throw retryError;
      }
    }
  }

  /** 空闲自动关闭（按需重建）。 */
  private scheduleIdleClose(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      void this.closeClient();
    }, IDLE_CLOSE_MS);
  }

  private async closeConnectedClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // 关闭失败不影响主流程
      }
    }
  }

  private async closeClient(): Promise<void> {
    await this.closeConnectedClient();
    const session = this.oauthSession;
    this.oauthSession = undefined;
    if (session !== undefined) {
      await session.close().catch(() => undefined);
    }
  }

  async checkReady(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const { tools } = await this.withClient((client) => client.listTools());
      const names = new Set(tools.map((tool) => tool.name));
      if (!names.has(this.connectionShortName) || !names.has(this.databaseShortName)) {
        return { ok: false, reason: "MCP 未提供获取连接与 database 的工具" };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async listConnections(): Promise<string[]> {
    const outcome = await this.withClient((client) => client.callTool({ name: this.connectionShortName, arguments: {} }));
    const names = parseOutcomeNames(outcome as ToolOutcomeLike);
    if (names === null) {
      throw new Error(`工具返回格式无法解析：${this.connectionShortName}`);
    }
    return names;
  }

  async listDatabases(connection: string): Promise<string[]> {
    const outcome = await this.withClient((client) =>
      client.callTool({ name: this.databaseShortName, arguments: { connection_name: connection } }),
    );
    const names = parseOutcomeNames(outcome as ToolOutcomeLike);
    if (names === null) {
      throw new Error(`工具返回格式无法解析：${this.databaseShortName}`);
    }
    return names;
  }

  /** 幂等释放（session_shutdown 兜底 + 空闲关闭共用）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeClient();
  }
}

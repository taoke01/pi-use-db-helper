/**
 * 启动甄别器（决策 D8，双轨 + description 语义判断）：
 * 1. 已知适配表（优先）：dbx → 两个工具短名（固化快路径，命中即用）；
 * 2. 通用兜底：按 namespace（mcp__<server>）归组，组内同时存在
 *    「connection 语义」与「database 语义」的工具（配对校验，缺一即淘汰）。
 *    语义判定以工具 description 为首要依据（如 "List database connections configured"
 *    / "List database names available"），名称模式仅作描述缺失时的兑底。
 * 纯函数实现，输入为工具结构子集，便于单元测试。
 */
import type { DiscoverCandidate, DiscoverTool } from "./types.ts";

export const MCP_NAMESPACE_PREFIX = "mcp__";

/** 已知适配表：server 名 → 两个工具短名。 */
export const ADAPTER_TABLE: Record<string, { connection: string; database: string }> = {
  dbx: { connection: "dbx_list_connections", database: "dbx_list_databases" },
};

/**
 * database 语义模式：描述表明返回 database 名单。
 * 「databases（复数）」或「database names / 数据库名称」；注意
 * "List database connections" 中的 database 是单数修饰语，不得误中。
 */
const DATABASE_DESC_PATTERN = /databases?\s+names?|\bdatabases\b|数据库名|数据库列表/i;

/** connection 语义模式：描述表明返回连接名单（connections）。 */
const CONNECTION_DESC_PATTERN = /\bconnections?\b|连接列表|列出.{0,12}连接/i;

/** 名称兑底模式（描述缺失或无语义信号时使用）。 */
const DATABASE_NAME_PATTERN = /list_?databases?|get_?databases?|show_?databases?/i;
const CONNECTION_NAME_PATTERN = /list_?connections?|get_?connections?|show_?connections?/i;

/** 工具语义分类结果。 */
export type ToolSemanticKind = "connection" | "database" | "unknown";

/** 工具全名中的短名：mcp__dbx__dbx_list_connections → dbx_list_connections。 */
export function shortToolName(fullName: string): string {
  const idx = fullName.lastIndexOf("__");
  if (idx === -1) {
    return fullName;
  }
  return fullName.slice(idx + 2);
}

/**
 * 按工具描述做语义分类（首要依据），描述缺失或无信号时退回名称模式。
 * 判定顺序：先 database 后 connection ——
 * "List database names ... through a DBX connection" 中 database 语义更特异，先命中即归类；
 * "List database connections configured" 中 database 为单数修饰语，database 模式不中，落入 connection。
 */
export function classifyTool(tool: DiscoverTool): ToolSemanticKind {
  const description = typeof tool.description === "string" ? tool.description : "";
  if (description !== "") {
    if (DATABASE_DESC_PATTERN.test(description)) {
      return "database";
    }
    if (CONNECTION_DESC_PATTERN.test(description)) {
      return "connection";
    }
  }
  const short = shortToolName(tool.name).toLowerCase();
  if (DATABASE_NAME_PATTERN.test(short)) {
    return "database";
  }
  if (CONNECTION_NAME_PATTERN.test(short)) {
    return "connection";
  }
  return "unknown";
}

/** 按 namespace 归组：返回 server → 工具列表（仅保留 mcp__ 组，保留 description 供语义分类）。 */
export function groupMcpTools(tools: DiscoverTool[]): Map<string, DiscoverTool[]> {
  const groups = new Map<string, DiscoverTool[]>();
  for (const tool of tools) {
    if (typeof tool.namespace !== "string" || !tool.namespace.startsWith(MCP_NAMESPACE_PREFIX)) {
      continue;
    }
    const server = tool.namespace.slice(MCP_NAMESPACE_PREFIX.length);
    if (server === "") {
      continue;
    }
    const list = groups.get(server);
    if (list === undefined) {
      groups.set(server, [tool]);
    } else {
      list.push(tool);
    }
  }
  return groups;
}

/** 在一个 server 组内执行语义配对校验；返回候选或 undefined（缺一即淘汰）。 */
function pairInGroup(server: string, tools: DiscoverTool[]): DiscoverCandidate | undefined {
  let connectionTool: string | undefined;
  let databaseTool: string | undefined;
  for (const tool of tools) {
    const kind = classifyTool(tool);
    if (kind === "connection" && connectionTool === undefined) {
      connectionTool = tool.name;
    }
    if (kind === "database" && databaseTool === undefined) {
      databaseTool = tool.name;
    }
  }
  if (connectionTool === undefined || databaseTool === undefined) {
    return undefined;
  }
  return { server, connectionTool, databaseTool };
}

/**
 * 甄别数据库类 MCP（双轨）：
 * 先按适配表精确匹配（并验证工具真实存在），再对未命中的组按 description 语义配对兜底。
 * 返回全部候选；调用方处理 0 / 1 / N 分支（设计 5.1）。
 */
export function pickDatabaseMcpCandidates(tools: DiscoverTool[]): DiscoverCandidate[] {
  const groups = groupMcpTools(tools);
  const candidates: DiscoverCandidate[] = [];
  const consumed = new Set<string>();
  for (const [server, adapter] of Object.entries(ADAPTER_TABLE)) {
    const groupTools = groups.get(server);
    if (groupTools === undefined) {
      continue;
    }
    const connectionTool = `mcp__${server}__${adapter.connection}`;
    const databaseTool = `mcp__${server}__${adapter.database}`;
    const hasConnection = groupTools.some((tool) => tool.name === connectionTool);
    const hasDatabase = groupTools.some((tool) => tool.name === databaseTool);
    if (hasConnection && hasDatabase) {
      candidates.push({ server, connectionTool, databaseTool });
      consumed.add(server);
    }
  }
  for (const [server, groupTools] of groups) {
    if (consumed.has(server)) {
      continue;
    }
    const candidate = pairInGroup(server, groupTools);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * pi-use-db-helper 共享类型定义。
 * 纯类型模块：不引入任何运行时依赖，便于单元测试直接导入。
 */

/** 全局配置文件结构（~/.pi/agent/pi-use-db-helper/pudh.json）。 */
export interface PudhConfig {
  /** 使用的数据库 MCP 名称（mcp.json 中的 server 键名） */
  using_mcp_name: string;
  /** 注入系统提示词的模板，支持 ${using_mcp_name}/${pudh_connection}/${pudh_database} */
  default_prompt: string;
  /** 该 MCP 上「列出连接」的工具名（短名或 mcp__ 完整名） */
  get_connection_tool_name: string;
  /** 该 MCP 上「列出 database」的工具名（入参含 connection_name） */
  get_database_tool_name: string;
}

/** 配置加载结果状态。 */
export type ConfigLoadStatus = "ok" | "generated" | "corrupted" | "repaired";

/** 配置加载结果。 */
export interface ConfigLoadResult {
  config: PudhConfig;
  status: ConfigLoadStatus;
  /** JSON 损坏时备份文件的路径 */
  backupPath?: string;
}

/** 会话内当前选择值。 */
export interface PudhSelection {
  connection: string | null;
  database: string | null;
}

/** 会话状态机相位。 */
export type PudhPhase = "UNSET" | "SELECTING" | "SET";

/** 持久化条目 data 结构（pi.appendEntry("pudh_state", data)）。 */
export interface PudhStateData {
  connection: string | null;
  database: string | null;
  updatedAt: string;
}

/** 甄别器输入：工具的结构子集（与 pi ToolInfo 结构兼容，解耦运行时类型）。 */
export interface DiscoverTool {
  name: string;
  /** MCP 工具的 namespace 形如 mcp__<server>；非 MCP 工具无此字段 */
  namespace?: string;
  /** 工具描述：语义甄别的首要依据（决策：根据工具描述判断，名称仅作兑底） */
  description?: string;
}

/** 选择器条目的标准格式（agent 将 MCP 工具原始输出转换后的产物）。 */
export interface PudhNamedEntry {
  /** 显示顺序（agent 生成的序号，从 1 起） */
  order: number;
  /** 连接名或数据库名 */
  name: string;
}

/** 甄别出的一个数据库类 MCP 候选。 */
export interface DiscoverCandidate {
  /** MCP server 名（来自 namespace，`-` 已被 pi 规范化为 `_`） */
  server: string;
  /** 「列出连接」工具的完整名（mcp__<server>__<tool>） */
  connectionTool: string;
  /** 「列出 database」工具的完整名 */
  databaseTool: string;
}

/** 通道无关的列表查询接口（MCP 双通道网关）。 */
export interface McpGateway {
  /** D9 校验：MCP 在线且两个 get_* 工具存在 */
  checkReady(): Promise<{ ok: boolean; reason?: string }>;
  listConnections(): Promise<string[]>;
  listDatabases(connection: string): Promise<string[]>;
  /** 幂等释放（通道二关闭 client，通道一为空操作） */
  dispose(): Promise<void>;
}

/** MCP HTTP OAuth 客户端配置（与 pi 的 mcp.json 字段兼容）。 */
export interface McpOAuthEntry {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: "dcr" | "cimd";
  authServerMetadataUrl?: string;
}

/** MCP 服务器配置（结构子集，兼容 pi 的 mcp.json 配置形状）。 */
export interface McpServerEntry {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthEntry;
}

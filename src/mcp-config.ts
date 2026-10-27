/**
 * 通道二配置源：从 mcp.json 文件直读目标 server 配置。
 * 事实依据（已核实 docs/mcp.md 与 pi 源码）：pi.getMcpServers() 仅返回扩展注册的
 * server；文件配置位于用户级 ~/.pi/agent/mcp.json 与项目级 .pi/mcp.json，
 * 项目条目覆盖同名用户条目。因此通道二按「项目优先」顺序直读文件。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerEntry } from "./types.ts";

/** 项目级 mcp.json 路径（<cwd>/.pi/mcp.json）。 */
export function projectMcpJsonPath(cwd: string): string {
  return path.join(cwd, ".pi", "mcp.json");
}

/** 用户级 mcp.json 路径（~/.pi/agent/mcp.json）。 */
export function userMcpJsonPath(home: string = os.homedir()): string {
  return path.join(home, ".pi", "agent", "mcp.json");
}

/**
 * 展开 ${VAR} 环境变量引用（pi 配置语法子集）。
 * - 变量已定义 → 替换；
 * - 变量未定义 → 保留原样（交由后续连接失败/降级处理）。
 * 注意：`!cmd` 命令引用不支持（本扩展不执行任意命令），原样保留。
 */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      return match;
    }
    return resolved;
  });
}

/** 展开配置中所有字符串值的环境变量引用。 */
export function expandServerEnvRefs(entry: McpServerEntry, env: NodeJS.ProcessEnv = process.env): McpServerEntry {
  const result: McpServerEntry = { ...entry };
  if (typeof result.command === "string") {
    result.command = expandEnvRefs(result.command, env);
  }
  if (Array.isArray(result.args)) {
    result.args = result.args.map((arg) => (typeof arg === "string" ? expandEnvRefs(arg, env) : arg));
  }
  if (result.env !== undefined) {
    const expanded: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.env)) {
      expanded[key] = typeof value === "string" ? expandEnvRefs(value, env) : value;
    }
    result.env = expanded;
  }
  if (typeof result.url === "string") {
    result.url = expandEnvRefs(result.url, env);
  }
  if (result.headers !== undefined) {
    const expanded: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.headers)) {
      expanded[key] = typeof value === "string" ? expandEnvRefs(value, env) : value;
    }
    result.headers = expanded;
  }
  if (result.oauth !== undefined) {
    const oauth = { ...result.oauth };
    for (const key of ["clientId", "clientSecret", "callbackUrl", "authServerMetadataUrl"] as const) {
      const value = oauth[key];
      if (typeof value === "string") {
        oauth[key] = expandEnvRefs(value, env);
      }
    }
    result.oauth = oauth;
  }
  return result;
}

/** server 名等价变体：pi 的 namespace 规范化把 `-` 换成 `_`，查找时互相兼容。 */
function nameVariants(serverName: string): string[] {
  const variants = new Set<string>([serverName]);
  variants.add(serverName.replace(/-/g, "_"));
  variants.add(serverName.replace(/_/g, "-"));
  return Array.from(variants);
}

/** 从单个 mcp.json 内容中提取指定 server 配置（兼容 { mcpServers: {...} } 与顶层直写）。 */
export function findServerInRaw(raw: unknown, serverName: string): McpServerEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  let servers: Record<string, unknown> | undefined;
  if (typeof obj.mcpServers === "object" && obj.mcpServers !== null) {
    servers = obj.mcpServers as Record<string, unknown>;
  } else {
    // 容错：顶层直写 { "server-name": {...} }
    servers = obj;
  }
  for (const variant of nameVariants(serverName)) {
    const hit = servers[variant];
    if (typeof hit === "object" && hit !== null) {
      return hit as McpServerEntry;
    }
  }
  return undefined;
}

/** 读取单个文件的 server 配置；文件缺失/损坏返回 undefined。 */
export function readServerFromFile(filePath: string, serverName: string): McpServerEntry | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
  return findServerInRaw(raw, serverName);
}

/**
 * 查找目标 server 配置：项目级优先，用户级兜底；
 * 命中后展开 ${VAR} 引用。均未命中返回 undefined（走 8#16 降级）。
 */
export function findServerConfig(cwd: string, serverName: string, home: string = os.homedir()): McpServerEntry | undefined {
  const fromProject = readServerFromFile(projectMcpJsonPath(cwd), serverName);
  if (fromProject !== undefined) {
    return expandServerEnvRefs(fromProject);
  }
  const fromUser = readServerFromFile(userMcpJsonPath(home), serverName);
  if (fromUser !== undefined) {
    return expandServerEnvRefs(fromUser);
  }
  return undefined;
}

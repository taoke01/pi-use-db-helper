/**
 * 配置加载器：~/.pi/agent/pi-use-db-helper/pudh.json 的读取、生成与容错。
 * 对应设计文档第 3 章（决策 D6）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConfigLoadResult, PudhConfig } from "./types.ts";

/** 注入系统提示词的默认模板（英文原句，占位符使用裁决后的单 n 拼写）。 */
export const DEFAULT_PROMPT =
  "When using the database, you must use the MCP tool provided by ${using_mcp_name}. " +
  "The database connection used is: ${pudh_connection}, and the database name under the connection is: ${pudh_database}.";

/** 默认配置模板（首次生成的内容，三个业务键均为空 → 触发甄别）。 */
export function defaultConfig(): PudhConfig {
  return {
    using_mcp_name: "",
    default_prompt: DEFAULT_PROMPT,
    get_connection_tool_name: "",
    get_database_tool_name: "",
  };
}

/** 配置目录：~/.pi/agent/pi-use-db-helper。 */
export function configDir(home: string = os.homedir()): string {
  return path.join(home, ".pi", "agent", "pi-use-db-helper");
}

/** 配置文件完整路径。 */
export function configFilePath(home: string = os.homedir()): string {
  return path.join(configDir(home), "pudh.json");
}

/** yyyyMMdd 备份后缀（如 .bak20261014）。 */
function backupSuffix(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `.bak${y}${m}${d}`;
}

/** 逐键校验并补齐缺失键；返回 [配置, 是否发生补齐]。 */
export function repairConfig(raw: unknown): [PudhConfig, boolean] {
  const base = defaultConfig();
  if (typeof raw !== "object" || raw === null) {
    return [base, true];
  }
  const obj = raw as Record<string, unknown>;
  let repaired = false;
  const result: PudhConfig = { ...base };
  const keys: Array<keyof PudhConfig> = [
    "using_mcp_name",
    "default_prompt",
    "get_connection_tool_name",
    "get_database_tool_name",
  ];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      result[key] = value;
    } else {
      repaired = true;
    }
  }
  return [result, repaired];
}

function writeConfigFile(filePath: string, config: PudhConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 加载配置（对应 3.5 / 3.6 容错规则）：
 * - 文件缺失 → 写入默认配置并返回 "generated"；
 * - JSON 损坏 → 备份为 pudh.json.bakyyyyMMdd 后重建并返回 "corrupted"；
 * - 键缺失/类型错误 → 仅补齐缺失键并写盘，返回 "repaired"；
 * - 正常返回 "ok"。
 */
export function loadConfig(home: string = os.homedir()): ConfigLoadResult {
  const filePath = configFilePath(home);
  if (!fs.existsSync(filePath)) {
    const config = defaultConfig();
    writeConfigFile(filePath, config);
    return { config, status: "generated" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    const backupPath = filePath + backupSuffix();
    fs.copyFileSync(filePath, backupPath);
    const config = defaultConfig();
    writeConfigFile(filePath, config);
    return { config, status: "corrupted", backupPath };
  }
  const [config, repaired] = repairConfig(raw);
  if (repaired) {
    writeConfigFile(filePath, config);
  }
  return { config, status: repaired ? "repaired" : "ok" };
}

/** 回填甄别结果并写盘（5.1：自动回填三个键）。 */
export function saveConfig(config: PudhConfig, home: string = os.homedir()): void {
  writeConfigFile(configFilePath(home), config);
}

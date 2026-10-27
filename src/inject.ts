/**
 * 占位符渲染与提示词 section 构建（决策 D1 / D2）。
 * 纯函数实现，便于单元测试。
 */
import type { PudhConfig } from "./types.ts";

/** 未设置时占位符的渲染值（决策 D2）。 */
export const UNSET_MARKER = "未设置";

/** 未设置时的引导句（决策 D2）。 */
export const UNSET_GUIDANCE = "需要数据库操作时必须先调用 pudh_setup_connection 工具";

/** 自定义 section 在 systemPromptOptions.sections 中的键名。 */
export const SECTION_KEY = "pudh";

/** 已知占位符键集合（决策 D2：已知键未提供时渲染为「未设置」）。 */
const KNOWN_KEYS = new Set<string>(["using_mcp_name", "pudh_connection", "pudh_database"]);

/**
 * 渲染模板：${key} 精确整串替换。
 * - 已知三键：vars 缺失或值为空/null → 替换为 UNSET_MARKER（决策 D2）；
 * - 未知占位符：vars 未提供 → 保留原样输出（3.4 容错，便于用户扩展自定义变量）；
 * - 未知占位符但 vars 提供了值 → 替换为对应值（自定义变量扩展）。
 */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    if (KNOWN_KEYS.has(key)) {
      const known = Object.hasOwn(vars, key) ? vars[key] : undefined;
      if (known === null || known === undefined || known === "") {
        return UNSET_MARKER;
      }
      return known;
    }
    if (!Object.hasOwn(vars, key)) {
      return match;
    }
    const value = vars[key];
    if (value === null || value === undefined || value === "") {
      return UNSET_MARKER;
    }
    return value;
  });
}

/**
 * 构建本轮注入的 section 文本：
 * - 三要素齐备 → 标准 section；
 * - 连接或 database 未设置 → 占位符渲染为「未设置」并追加引导句（决策 D2）。
 * using_mcp_name 为空时调用方应直接跳过注入（3.2 止步规则）。
 */
export function buildSection(config: PudhConfig, connection: string | null, database: string | null): string {
  const vars: Record<string, string | null> = {
    using_mcp_name: config.using_mcp_name,
    pudh_connection: connection,
    pudh_database: database,
  };
  const rendered = renderTemplate(config.default_prompt, vars);
  if (connection === null || connection === "" || database === null || database === "") {
    return rendered + "\n" + UNSET_GUIDANCE;
  }
  return rendered;
}

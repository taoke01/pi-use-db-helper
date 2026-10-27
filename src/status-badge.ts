/**
 * 状态栏指示器（决策 D11）：
 * ctx.ui.setStatus("pudh", text) —— pi footer 的按键组合式扩展状态条目。
 * 事实依据（已核实 pi 内建 footer 源码）：扩展状态独立成行渲染；
 * 多扩展状态同行拼接 → 文本必须以 ANSI 复位收尾，防止颜色外溢。
 */

/** ANSI SGR 紫色码（终端原生紫，兼容性最佳；开放问题 #6：v1.0.0 固定）。 */
export const ANSI_PURPLE = "\x1b[35m";

/** ANSI 复位码（必须收尾，防止污染相邻状态条目）。 */
export const ANSI_RESET = "\x1b[0m";

/** 状态条目 key（按字母序参与 footer 排列）。 */
export const STATUS_KEY = "pudh";

/** 清理名称中的换行/制表符/回车（footer 的 sanitizeStatusText 会替换为空格，提前清理保持确定性）。 */
function sanitizeName(name: string): string {
  return name.replace(/[\r\n\t]/g, " ").trim();
}

/**
 * 格式化徽标文本：>[DB]连接名称_database名称<，紫色包裹 + 复位收尾。
 * 仅在 connection 与 database 均非空时调用（由 applyBadge 保证）。
 */
export function formatBadge(connection: string, database: string): string {
  const text = `>[DB]${sanitizeName(connection)}_${sanitizeName(database)}<`;
  return ANSI_PURPLE + text + ANSI_RESET;
}

/**
 * 按运行时状态刷新状态栏徽标：
 * - SET → 显示紫色徽标；
 * - 其他相位 → 清除条目（传 undefined）。
 * setStatus 不可用（RPC 未转发 / 无 UI）时静默跳过（错误矩阵 #17）。
 */
export function applyBadge(
  ui: { setStatus?: (key: string, text: string | undefined) => void } | undefined,
  selection: { connection: string | null; database: string | null },
  phase: string,
): void {
  if (ui === undefined || typeof ui.setStatus !== "function") {
    return;
  }
  if (phase === "SET" && selection.connection !== null && selection.database !== null) {
    try {
      ui.setStatus(STATUS_KEY, formatBadge(selection.connection, selection.database));
    } catch {
      // 状态栏更新失败不阻塞主流程（8#17）
    }
    return;
  }
  try {
    ui.setStatus(STATUS_KEY, undefined);
  } catch {
    // 同上：静默跳过
  }
}

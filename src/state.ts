/**
 * 会话状态机与会话恢复（决策 D7 / D9）。
 * 转移逻辑为纯函数；持久化依赖 pi.appendEntry（由入口层装配）。
 */
import type { PudhPhase, PudhSelection, PudhStateData } from "./types.ts";

/** 恢复扫描输入：分支条目的结构子集（与 pi SessionEntry 兼容）。 */
export interface BranchEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

/** 会话运行时状态：相位 + 当前选择值。 */
export interface PudhRuntimeState {
  phase: PudhPhase;
  selection: PudhSelection;
}

export function initialState(): PudhRuntimeState {
  return { phase: "UNSET", selection: { connection: null, database: null } };
}

/** 是否已处于选择中（SELECTING 互斥依据）。 */
export function isSelecting(state: PudhRuntimeState): boolean {
  return state.phase === "SELECTING";
}

/** 进入选择：SET → SELECTING（重新设置）或 UNSET → SELECTING；已 SELECTING 返回 null 表示拒绝。 */
export function beginSelecting(state: PudhRuntimeState): PudhRuntimeState | null {
  if (state.phase === "SELECTING") {
    return null;
  }
  return { ...state, phase: "SELECTING" };
}

/** 写入成功：SELECTING/SET → SET，并更新选择值（决策 D11：调用方随后刷新状态栏）。 */
export function commitSelection(state: PudhRuntimeState, connection: string, database: string): PudhRuntimeState {
  return { phase: "SET", selection: { connection, database } };
}

/**
 * 取消（决策 D4）：
 * - 取消时已有原值（此前为 SET）→ 保持原值回到 SET；
 * - 无原值 → 回到 UNSET。
 */
export function cancelSelecting(state: PudhRuntimeState): PudhRuntimeState {
  const hasPrevious = state.selection.connection !== null && state.selection.database !== null;
  if (hasPrevious) {
    return { phase: "SET", selection: state.selection };
  }
  return initialState();
}

/** 清除选择：任意相位 → UNSET（供 reset 演进预留）。 */
export function clearSelection(_state: PudhRuntimeState): PudhRuntimeState {
  return initialState();
}

/** 构造持久化条目 data。 */
export function buildStateData(selection: PudhSelection, now: Date = new Date()): PudhStateData {
  return { connection: selection.connection, database: selection.database, updatedAt: now.toISOString() };
}

/** 判断条目是否为本扩展的状态条目。 */
function isPudhStateEntry(entry: BranchEntryLike): boolean {
  return entry.type === "custom" && entry.customType === "pudh_state";
}

/** 校验并提取条目 data。 */
function extractStateData(data: unknown): PudhStateData | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.updatedAt !== "string") {
    return undefined;
  }
  const connection = typeof obj.connection === "string" ? obj.connection : null;
  const database = typeof obj.database === "string" ? obj.database : null;
  return { connection, database, updatedAt: obj.updatedAt };
}

/**
 * 恢复（4.3）：遍历分支条目（getBranch 结果，非全文件），
 * 取最后一条 pudh_state 条目；未命中返回 null。
 * 按决策 D9：恢复时不校验连接有效性。
 */
export function restoreFromBranch(entries: BranchEntryLike[]): PudhStateData | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isPudhStateEntry(entry)) {
      continue;
    }
    const data = extractStateData(entry.data);
    if (data !== undefined) {
      return data;
    }
  }
  return null;
}

/** 由恢复数据构建运行时状态（无效值视为 UNSET）。 */
export function applyRestored(stateData: PudhStateData | null): PudhRuntimeState {
  if (stateData === null || stateData.connection === null || stateData.database === null) {
    return initialState();
  }
  return {
    phase: "SET",
    selection: { connection: stateData.connection, database: stateData.database },
  };
}

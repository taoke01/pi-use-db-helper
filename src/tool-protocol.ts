/**
 * 工具路径标准协议（设计 5.3，agent 介入转换）：
 * MCP 工具的原始输出格式不可控（Markdown 表格 / 无序列表 / JSON 等），
 * 由 agent 将其转换为标准条目 [{"order":1,"name":"名称"}] 后传入本扩展渲染。
 * 本模块只做纯函数校验/排序/阶段判定，便于单元测试。
 */
import type { PudhNamedEntry } from "./types.ts";

/** 工具参数的原始形态（typebox 校验后的宽松视图）。 */
export interface SetupToolParams {
  connections?: unknown;
  connection?: unknown;
  databases?: unknown;
}

/** 两阶段协议的阶段判定结果。 */
export type SetupStage = "stage1" | "stage2" | "invalid";

/** 校验单条条目：order 为有限数字（无效视为排最后），name 为非空字符串。 */
function toEntry(raw: unknown): PudhNamedEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name.trim() === "") {
    return undefined;
  }
  const order = typeof record.order === "number" && Number.isFinite(record.order) ? record.order : Number.POSITIVE_INFINITY;
  return { order, name: name.trim() };
}

/**
 * 解析 agent 转换后的条目数组；格式非法返回 null（由调用方 isError 引导重传）。
 * 容错：丢弃无法解析的条目；order 缺失/非法不拒绝（排最后）；按 order 稳定排序；同名去重。
 */
export function parseEntries(raw: unknown): PudhNamedEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const entries: PudhNamedEntry[] = [];
  for (const item of raw) {
    const entry = toEntry(item);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    return null;
  }
  entries.sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const unique: PudhNamedEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      unique.push(entry);
    }
  }
  return unique;
}

/** 判定本次调用属于协议哪个阶段（设计 5.3：先 connections，后 connection + databases）。 */
export function decideStage(params: SetupToolParams): SetupStage {
  const hasConnections = Array.isArray(params.connections) && params.connections.length > 0;
  const hasStage2 = typeof params.connection === "string" && params.connection !== "" && Array.isArray(params.databases) && params.databases.length > 0;
  if (hasConnections) {
    return "stage1";
  }
  if (hasStage2) {
    return "stage2";
  }
  return "invalid";
}

/** 渲染用名称列表（去 order 字段）。 */
export function entryNames(entries: PudhNamedEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

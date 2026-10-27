import { describe, expect, it } from "vitest";
import {
  applyRestored,
  beginSelecting,
  buildStateData,
  cancelSelecting,
  clearSelection,
  commitSelection,
  initialState,
  isSelecting,
  restoreFromBranch,
} from "../src/state.ts";
import type { BranchEntryLike } from "../src/state.ts";

describe("state: 状态机转移（4.1）", () => {
  it("初始状态为 UNSET", () => {
    expect(initialState()).toEqual({ phase: "UNSET", selection: { connection: null, database: null } });
  });

  it("UNSET → SELECTING", () => {
    const next = beginSelecting(initialState());
    expect(next?.phase).toBe("SELECTING");
  });

  it("SET → SELECTING（重新设置）", () => {
    const set = commitSelection(initialState(), "prod", "Orders");
    const next = beginSelecting(set);
    expect(next?.phase).toBe("SELECTING");
  });

  it("SELECTING 互斥：再次 beginSelecting 返回 null（8#14）", () => {
    const selecting = beginSelecting(initialState());
    expect(beginSelecting(selecting ?? initialState())).toBeNull();
    expect(isSelecting(selecting ?? initialState())).toBe(true);
  });

  it("SELECTING → SET：写入成功（决策 D11 联动由调用方处理）", () => {
    const selecting = beginSelecting(initialState()) ?? initialState();
    const next = commitSelection(selecting, "prod", "Orders");
    expect(next.phase).toBe("SET");
    expect(next.selection).toEqual({ connection: "prod", database: "Orders" });
  });

  it("取消（无原值）→ UNSET（决策 D4）", () => {
    const selecting = beginSelecting(initialState()) ?? initialState();
    const next = cancelSelecting(selecting);
    expect(next.phase).toBe("UNSET");
    expect(next.selection.connection).toBeNull();
  });

  it("取消（已有原值）→ 保持原值回 SET（决策 D4）", () => {
    const set = commitSelection(initialState(), "prod", "Orders");
    const selecting = beginSelecting(set) ?? initialState();
    const next = cancelSelecting(selecting);
    expect(next.phase).toBe("SET");
    expect(next.selection).toEqual({ connection: "prod", database: "Orders" });
  });

  it("clearSelection：任意相位 → UNSET（reset 演进预留）", () => {
    const set = commitSelection(initialState(), "prod", "Orders");
    expect(clearSelection(set).phase).toBe("UNSET");
  });
});

describe("state: 持久化与恢复（4.2 / 4.3）", () => {
  it("buildStateData 生成 ISO 时间戳", () => {
    const data = buildStateData({ connection: "prod", database: "Orders" }, new Date("2026-10-14T00:00:00Z"));
    expect(data).toEqual({ connection: "prod", database: "Orders", updatedAt: "2026-10-14T00:00:00.000Z" });
  });

  it("restoreFromBranch 取最后一条 pudh_state（条目过滤）", () => {
    const entries: BranchEntryLike[] = [
      { type: "message" },
      { type: "custom", customType: "pudh_state", data: { connection: "old", database: "A", updatedAt: "t1" } },
      { type: "message" },
      { type: "custom", customType: "pudh_state", data: { connection: "new", database: "B", updatedAt: "t2" } },
    ];
    expect(restoreFromBranch(entries)).toEqual({ connection: "new", database: "B", updatedAt: "t2" });
  });

  it("无记录 → null（UNSET）", () => {
    expect(restoreFromBranch([{ type: "message" }, { type: "custom", customType: "other" }])).toBeNull();
    expect(restoreFromBranch([])).toBeNull();
  });

  it("损坏的 data 条目被跳过，取更早的有效条目", () => {
    const entries: BranchEntryLike[] = [
      { type: "custom", customType: "pudh_state", data: { connection: "ok", database: "A", updatedAt: "t1" } },
      { type: "custom", customType: "pudh_state", data: { broken: true } },
    ];
    expect(restoreFromBranch(entries)).toEqual({ connection: "ok", database: "A", updatedAt: "t1" });
  });

  it("非对象 data 视为无记录", () => {
    expect(restoreFromBranch([{ type: "custom", customType: "pudh_state", data: "garbage" }])).toBeNull();
  });

  it("applyRestored：有效数据 → SET；无效 → UNSET（决策 D9 不校验连接有效性）", () => {
    const restored = applyRestored({ connection: "prod", database: "Orders", updatedAt: "t" });
    expect(restored.phase).toBe("SET");
    expect(applyRestored(null).phase).toBe("UNSET");
    expect(applyRestored({ connection: null, database: "x", updatedAt: "t" }).phase).toBe("UNSET");
  });
});

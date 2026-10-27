import { describe, expect, it, vi } from "vitest";
import { ANSI_PURPLE, ANSI_RESET, STATUS_KEY, applyBadge, formatBadge } from "../src/status-badge.ts";

describe("status-badge: formatBadge（决策 D11）", () => {
  it("格式为 >[DB]连接_database<", () => {
    expect(formatBadge("prod", "Orders")).toBe(`${ANSI_PURPLE}>[DB]prod_Orders<${ANSI_RESET}`);
  });

  it("紫色开启且以复位收尾（防止同行拼接颜色外溢）", () => {
    const badge = formatBadge("c", "d");
    expect(badge.startsWith("\x1b[35m")).toBe(true);
    expect(badge.endsWith("\x1b[0m")).toBe(true);
  });

  it("名称中的换行/制表符被清理", () => {
    const badge = formatBadge("pr\neat", "Or\tders");
    expect(badge).toBe(`${ANSI_PURPLE}>[DB]pr eat_Or ders<${ANSI_RESET}`);
    expect(badge).not.toMatch(/[\r\n\t]/);
  });
});

describe("status-badge: applyBadge", () => {
  function mockUi() {
    return { setStatus: vi.fn() };
  }

  it("SET → 写入紫色徽标", () => {
    const ui = mockUi();
    applyBadge(ui, { connection: "prod", database: "Orders" }, "SET");
    expect(ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, formatBadge("prod", "Orders"));
  });

  it("UNSET → 传 undefined 清除条目", () => {
    const ui = mockUi();
    applyBadge(ui, { connection: null, database: null }, "UNSET");
    expect(ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("SELECTING 且有原值 → 仍清除（仅 SET 展示）", () => {
    const ui = mockUi();
    applyBadge(ui, { connection: "prod", database: "Orders" }, "SELECTING");
    expect(ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("setStatus 不可用（RPC 未转发 / 无 UI）→ 静默跳过（8#17）", () => {
    expect(() => applyBadge(undefined, { connection: "c", database: "d" }, "SET")).not.toThrow();
    expect(() => applyBadge({}, { connection: "c", database: "d" }, "SET")).not.toThrow();
  });

  it("setStatus 抛异常 → 静默吞掉，不阻塞主流程（8#17）", () => {
    const ui = { setStatus: vi.fn(() => { throw new Error("boom"); }) };
    expect(() => applyBadge(ui, { connection: "c", database: "d" }, "SET")).not.toThrow();
  });
});

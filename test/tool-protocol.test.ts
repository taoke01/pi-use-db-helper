import { describe, expect, it } from "vitest";
import { decideStage, entryNames, parseEntries, type SetupToolParams } from "../src/tool-protocol.ts";

describe("tool-protocol: parseEntries（agent 转换后的标准格式）", () => {
  it("标准格式解析并按 order 排序", () => {
    const entries = parseEntries([{ order: 2, name: "b" }, { order: 1, name: "a" }]);
    expect(entries).toEqual([{ order: 1, name: "a" }, { order: 2, name: "b" }]);
    expect(entryNames(entries ?? [])).toEqual(["a", "b"]);
  });

  it("order 缺失/非法 → 排最后（不拒收整批；同为无序时保持传入顺序）", () => {
    const entries = parseEntries([{ name: "z" }, { order: 1, name: "a" }, { order: "x", name: "m" }]);
    expect(entryNames(entries ?? [])).toEqual(["a", "z", "m"]);
  });

  it("name 缺失/空串的条目被丢弃；全无效 → null", () => {
    expect(parseEntries([{ order: 1 }, { name: "" }, "junk"])).toBeNull();
  });

  it("同名去重（保留首个 order）", () => {
    const entries = parseEntries([{ order: 2, name: "dup" }, { order: 1, name: "dup" }, { order: 3, name: "x" }]);
    expect(entries).toEqual([{ order: 1, name: "dup" }, { order: 3, name: "x" }]);
  });

  it("name 首尾空白被 trim", () => {
    expect(parseEntries([{ order: 1, name: "  prod  " }])).toEqual([{ order: 1, name: "prod" }]);
  });

  it("空数组 / 非数组 → null", () => {
    expect(parseEntries([])).toBeNull();
    expect(parseEntries("garbage")).toBeNull();
    expect(parseEntries(undefined)).toBeNull();
  });
});

describe("tool-protocol: decideStage（两阶段判定）", () => {
  const entry = { order: 1, name: "x" };

  it("connections 非空数组 → stage1（优先级高于阶段2字段）", () => {
    expect(decideStage({ connections: [entry] } satisfies SetupToolParams)).toBe("stage1");
    expect(decideStage({ connections: [entry], connection: "c", databases: [entry] } satisfies SetupToolParams)).toBe("stage1");
  });

  it("connection 非空串 + databases 非空数组 → stage2", () => {
    expect(decideStage({ connection: "3.156", databases: [entry] } satisfies SetupToolParams)).toBe("stage2");
  });

  it("参数缺失/空值 → invalid", () => {
    expect(decideStage({} satisfies SetupToolParams)).toBe("invalid");
    expect(decideStage({ connections: [] } satisfies SetupToolParams)).toBe("invalid");
    expect(decideStage({ connection: "", databases: [entry] } satisfies SetupToolParams)).toBe("invalid");
    expect(decideStage({ connection: "c" } satisfies SetupToolParams)).toBe("invalid");
    expect(decideStage({ databases: [entry] } satisfies SetupToolParams)).toBe("invalid");
  });
});

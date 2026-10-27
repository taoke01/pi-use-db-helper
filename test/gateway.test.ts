import { describe, expect, it } from "vitest";
import { aggregateText, parseNameList, parseOutcomeNames, resolveShortToolName } from "../src/gateway.ts";

describe("gateway: aggregateText", () => {
  it("聚合多段 text 内容", () => {
    const outcome = { result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } };
    expect(aggregateText(outcome)).toBe("a\nb");
  });

  it("MCP SDK callTool 形状：content 在顶层（无 result 包装）", () => {
    const outcome = { content: [{ type: "text", text: "| ID | Name |\n| --- | --- |\n| x | 3.156 |" }], isError: false };
    expect(aggregateText(outcome)).toContain("3.156");
  });

  it("无内容 → 空串", () => {
    expect(aggregateText({})).toBe("");
    expect(aggregateText({ result: { content: [] } })).toBe("");
  });
});

describe("gateway: parseNameList（8#11 容错）", () => {
  it("JSON 数组直接解析", () => {
    expect(parseNameList('["prod","dev"]')).toEqual(["prod", "dev"]);
  });

  it("对象包裹 data/results/items 字段", () => {
    expect(parseNameList('{"data":["a","b"]}')).toEqual(["a", "b"]);
    expect(parseNameList('{"results":["x"]}')).toEqual(["x"]);
  });

  it("对象数组提取 name/connection/database 字段", () => {
    expect(parseNameList('[{"name":"prod"},{"name":"dev"}]')).toEqual(["prod", "dev"]);
    expect(parseNameList('[{"connection":"c1"},{"connection":"c2"}]')).toEqual(["c1", "c2"]);
  });

  it("多层包裹递归提取", () => {
    expect(parseNameList('{"data":{"results":["deep"]}}')).toEqual(["deep"]);
  });

  it("非 JSON → 逐行退化解析", () => {
    expect(parseNameList("prod\ndev\n")).toEqual(["prod", "dev"]);
  });

  it("逐行模式过滤空行与装饰行", () => {
    expect(parseNameList("prod\n---\n\ndev\n-\n")).toEqual(["prod", "dev"]);
  });

  it("空文本 → 空数组", () => {
    expect(parseNameList("")).toEqual([]);
    expect(parseNameList("   \n  ")).toEqual([]);
  });

  it("JSON 标量/无法提取 → 逐行退化", () => {
    expect(parseNameList("42")).toEqual(["42"]);
  });
});

describe("gateway: parseOutcomeNames", () => {
  it("isError → null（上抛语义）", () => {
    expect(parseOutcomeNames({ isError: true, result: { content: [{ type: "text", text: "[]" }] } })).toBeNull();
    expect(parseOutcomeNames({ result: { isError: true, content: [{ type: "text", text: "[]" }] } })).toBeNull();
  });

  it("正常结果解析", () => {
    expect(parseOutcomeNames({ result: { content: [{ type: "text", text: '["prod"]' }] } })).toEqual(["prod"]);
  });
});

describe("gateway: 工具名解析", () => {
  it("resolveShortToolName（通道二）：剥离 pi 命名空间包装", () => {
    expect(resolveShortToolName("mcp__dbx__dbx_list_connections")).toBe("dbx_list_connections");
    expect(resolveShortToolName("dbx_list_connections")).toBe("dbx_list_connections");
    expect(resolveShortToolName("mcp__solo")).toBe("solo");
  });
});

describe("gateway: parseNameList 的 Markdown 形态（dbx 实测校准）", () => {
  it("Markdown 表格：提取表头 Name 列（dbx_list_connections 真实输出）", () => {
    const text = [
      "| ID | Name | Group Path | Type | Host | Port | Database | Note |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 365c3dd2-f038-47f9-86eb-3b4dca6eb109 | 3.156 |  | mysql | 192.168.3.156 | 3306 |  |  |",
      "| acb0881b-d4be-4237-9229-28a67c2bfe82 | 3.185 |  | mysql | 192.168.3.185 | 3306 |  |  |",
      "| e5b24ad9-75f3-44c5-92e0-0e03e31d4532 | 3.219 |  | mysql | 192.168.3.219 | 3306 |  | 组件库 |",
    ].join("\n");
    expect(parseNameList(text)).toEqual(["3.156", "3.185", "3.219"]);
  });

  it("Markdown 无序列表：剥离 - 前缀（dbx_list_databases 真实输出）", () => {
    expect(parseNameList("- tnbs-yth-threed-dev-v2\n- tnbs-yth-threed-v2")).toEqual([
      "tnbs-yth-threed-dev-v2",
      "tnbs-yth-threed-v2",
    ]);
  });

  it("Markdown 表格无数据行 → 空数组", () => {
    const text = "| ID | Name |\n| --- | --- |";
    expect(parseNameList(text)).toEqual([]);
  });

  it("表格无 Name 列 → 退化为逐行（剥离前缀后）", () => {
    const text = "| ID | Host |\n| --- | --- |\n| 1 | 127.0.0.1 |";
    expect(parseNameList(text)).toEqual(["| ID | Host |", "| --- | --- |", "| 1 | 127.0.0.1 |"]);
  });

  it("* 星号无序列表同样剥离", () => {
    expect(parseNameList("* prod\n* dev")).toEqual(["prod", "dev"]);
  });
});

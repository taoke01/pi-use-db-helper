import { describe, expect, it } from "vitest";
import { ADAPTER_TABLE, classifyTool, groupMcpTools, pickDatabaseMcpCandidates, shortToolName } from "../src/discover.ts";
import type { DiscoverTool } from "../src/types.ts";

function tool(name: string, namespace?: string, description?: string): DiscoverTool {
  const item: DiscoverTool = namespace === undefined ? { name } : { name, namespace };
  if (description !== undefined) {
    item.description = description;
  }
  return item;
}

describe("discover: 基础工具", () => {
  it("shortToolName 取最后一段", () => {
    expect(shortToolName("mcp__dbx__dbx_list_connections")).toBe("dbx_list_connections");
    expect(shortToolName("plain_tool")).toBe("plain_tool");
    expect(shortToolName("mcp__solo")).toBe("solo");
  });

  it("groupMcpTools 仅保留 mcp__ 前缀组，非 MCP 工具被忽略", () => {
    const groups = groupMcpTools([
      tool("read", undefined),
      tool("mcp__dbx__a", "mcp__dbx"),
      tool("mcp__dbx__b", "mcp__dbx"),
      tool("bash", ""),
    ]);
    expect(groups.get("dbx")?.map((item) => item.name)).toEqual(["mcp__dbx__a", "mcp__dbx__b"]);
    expect(groups.has("")).toBe(false);
    expect(groups.size).toBe(1);
  });
});

describe("discover: classifyTool（description 语义判断）", () => {
  it("dbx 真实描述校准：connections 描述 → connection", () => {
    expect(classifyTool(tool("mcp__dbx__dbx_list_connections", "mcp__dbx", "List database connections configured in DBX."))).toBe("connection");
  });

  it("dbx 真实描述校准：database names 描述 → database（即便句中含 connection）", () => {
    expect(classifyTool(tool("mcp__dbx__dbx_list_databases", "mcp__dbx", "List database names available through a DBX connection."))).toBe("database");
  });

  it("中文描述：列出数据库连接 → connection；数据库名称 → database", () => {
    expect(classifyTool(tool("t1", "mcp__c", "列出所有数据库连接"))).toBe("connection");
    expect(classifyTool(tool("t2", "mcp__c", "返回可用的数据库名称"))).toBe("database");
  });

  it("描述缺失 → 名称兑底（list_connections / list_databases）", () => {
    expect(classifyTool(tool("mcp__x__list_connections", "mcp__x"))).toBe("connection");
    expect(classifyTool(tool("mcp__x__list_databases", "mcp__x"))).toBe("database");
  });

  it("描述存在但无语义信号 → 名称兑底", () => {
    expect(classifyTool(tool("mcp__x__list_connections", "mcp__x", "Standard tool entry."))).toBe("connection");
  });

  it("描述与名称均无语义信号 → unknown", () => {
    expect(classifyTool(tool("mcp__w__get_weather", "mcp__w", "Get current weather forecast."))).toBe("unknown");
  });

  it("无关描述但名称有信号 → 仍按名称归类", () => {
    expect(classifyTool(tool("mcp__x__dbx_list_databases", "mcp__x", "Internal helper."))).toBe("database");
  });
});

describe("discover: 双轨甄别（决策 D8）", () => {
  it("适配表命中：dbx 且两个工具真实存在", () => {
    const tools = [
      tool("mcp__dbx__dbx_list_connections", "mcp__dbx"),
      tool("mcp__dbx__dbx_list_databases", "mcp__dbx"),
      tool("mcp__dbx__dbx_query", "mcp__dbx"),
    ];
    const candidates = pickDatabaseMcpCandidates(tools);
    expect(candidates).toEqual([
      { server: "dbx", connectionTool: "mcp__dbx__dbx_list_connections", databaseTool: "mcp__dbx__dbx_list_databases" },
    ]);
  });

  it("适配表键存在但工具缺失 → 落通用兜底判定（不因适配表误报）", () => {
    const tools = [
      tool("mcp__dbx__list_connections", "mcp__dbx"),
      tool("mcp__dbx__list_databases", "mcp__dbx"),
    ];
    const candidates = pickDatabaseMcpCandidates(tools);
    // 适配表要求的 dbx_list_* 不存在；兜底按语义配对命中
    expect(candidates).toEqual([
      { server: "dbx", connectionTool: "mcp__dbx__list_connections", databaseTool: "mcp__dbx__list_databases" },
    ]);
  });

  it("通用兜底：非适配表 server 语义配对命中", () => {
    const tools = [
      tool("mcp__pgmcp__list_connections", "mcp__pgmcp"),
      tool("mcp__pgmcp__list_databases", "mcp__pgmcp"),
    ];
    const candidates = pickDatabaseMcpCandidates(tools);
    expect(candidates).toEqual([
      { server: "pgmcp", connectionTool: "mcp__pgmcp__list_connections", databaseTool: "mcp__pgmcp__list_databases" },
    ]);
  });

  it("description 语义兜底：工具名不含关键词，靠描述配对命中", () => {
    const tools = [
      tool("mcp__oddb__fetch_sources", "mcp__oddb", "List all database connections configured in the workspace."),
      tool("mcp__oddb__fetch_targets", "mcp__oddb", "List database names available for a given connection."),
    ];
    expect(pickDatabaseMcpCandidates(tools)).toEqual([
      { server: "oddb", connectionTool: "mcp__oddb__fetch_sources", databaseTool: "mcp__oddb__fetch_targets" },
    ]);
  });

  it("描述均无关 → 淘汰（即便 server 存在）", () => {
    const tools = [
      tool("mcp__w__get_weather", "mcp__w", "Get current weather forecast."),
      tool("mcp__w__get_news", "mcp__w", "Fetch latest news headlines."),
    ];
    expect(pickDatabaseMcpCandidates(tools)).toEqual([]);
  });

  it("缺配对被淘汰：仅有 list_connections", () => {
    const tools = [tool("mcp__x__list_connections", "mcp__x")];
    expect(pickDatabaseMcpCandidates(tools)).toEqual([]);
  });

  it("缺配对被淘汰：仅有 list_databases", () => {
    const tools = [tool("mcp__x__list_databases", "mcp__x")];
    expect(pickDatabaseMcpCandidates(tools)).toEqual([]);
  });

  it("零候选：无任何数据库类 MCP（如 idea 类）", () => {
    const tools = [
      tool("mcp__idea__get_current_file", "mcp__idea"),
      tool("mcp__idea__search_symbols", "mcp__idea"),
      tool("read"),
      tool("bash"),
    ];
    expect(pickDatabaseMcpCandidates(tools)).toEqual([]);
  });

  it("多候选：适配表与兜底各命中一个，返回两条", () => {
    const tools = [
      tool("mcp__dbx__dbx_list_connections", "mcp__dbx"),
      tool("mcp__dbx__dbx_list_databases", "mcp__dbx"),
      tool("mcp__other__list_connections", "mcp__other"),
      tool("mcp__other__list_databases", "mcp__other"),
    ];
    const candidates = pickDatabaseMcpCandidates(tools);
    expect(candidates.map((candidate) => candidate.server)).toEqual(["dbx", "other"]);
  });

  it("适配表命中后不重复进入兜底（同一 server 仅一条）", () => {
    const tools = [
      tool("mcp__dbx__dbx_list_connections", "mcp__dbx"),
      tool("mcp__dbx__dbx_list_databases", "mcp__dbx"),
    ];
    const candidates = pickDatabaseMcpCandidates(tools);
    expect(candidates.length).toBe(1);
  });

  it("适配表内容与裁决一致（dbx 两个短名）", () => {
    expect(ADAPTER_TABLE.dbx).toEqual({ connection: "dbx_list_connections", database: "dbx_list_databases" });
  });
});

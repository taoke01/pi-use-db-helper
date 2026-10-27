import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT } from "../src/config.ts";
import { UNSET_GUIDANCE, UNSET_MARKER, buildSection, renderTemplate } from "../src/inject.ts";
import { defaultConfig } from "../src/config.ts";

describe("inject: renderTemplate（3.4）", () => {
  it("全设：三个占位符精确整串替换", () => {
    const rendered = renderTemplate(DEFAULT_PROMPT, {
      using_mcp_name: "dbx",
      pudh_connection: "prod",
      pudh_database: "Orders",
    });
    expect(rendered).toContain("provided by dbx.");
    expect(rendered).toContain("connection used is: prod");
    expect(rendered).toContain("database name under the connection is: Orders.");
    expect(rendered).not.toContain("${");
  });

  it("未知占位符（vars 未提供）保留原样（3.4 容错）", () => {
    const rendered = renderTemplate("A=${a} B=${b}", { a: "x" });
    expect(rendered).toBe("A=x B=${b}");
  });

  it("已知三键部分设置：未设键渲染「未设置」，已设键正常替换（决策 D2）", () => {
    const rendered = renderTemplate("conn=${pudh_connection} db=${pudh_database}", { pudh_connection: "prod" });
    expect(rendered).toBe("conn=prod db=未设置");
  });

  it("已知三键未传入 vars → 渲染为「未设置」（D2 边界）", () => {
    expect(renderTemplate("conn=${pudh_connection}", {})).toBe("conn=未设置");
  });

  it("自定义变量：未知键但 vars 提供了值 → 替换（用户扩展）", () => {
    expect(renderTemplate("team=${my_var}", { my_var: "db-platform" })).toBe("team=db-platform");
  });

  it("全未设：全部渲染为「未设置」", () => {
    const rendered = renderTemplate(DEFAULT_PROMPT, {
      using_mcp_name: "dbx",
      pudh_connection: null,
      pudh_database: null,
    });
    expect(rendered).toContain(`is: ${UNSET_MARKER},`);
    expect(rendered).toContain(`is: ${UNSET_MARKER}.`);
  });

  it("未知占位符保留原样输出（容错）", () => {
    const rendered = renderTemplate("known=${a} unknown=${mystery}", { a: "1" });
    expect(rendered).toBe("known=1 unknown=${mystery}");
  });

  it("模板无占位符 → 原样返回", () => {
    expect(renderTemplate("plain text", { a: "1" })).toBe("plain text");
  });

  it("空串值渲染为「未设置」", () => {
    expect(renderTemplate("v=${a}", { a: "" })).toBe("v=未设置");
  });
});

describe("inject: buildSection（决策 D2）", () => {
  it("三要素齐备 → 标准 section，无引导句", () => {
    const config = defaultConfig();
    config.using_mcp_name = "dbx";
    const section = buildSection(config, "prod", "Orders");
    expect(section).not.toContain(UNSET_GUIDANCE);
    expect(section).toContain("prod");
    expect(section).toContain("Orders");
  });

  it("未设置 → 末尾追加引导句", () => {
    const config = defaultConfig();
    config.using_mcp_name = "dbx";
    const section = buildSection(config, null, null);
    expect(section.endsWith(UNSET_GUIDANCE)).toBe(true);
    expect(section).toContain(UNSET_MARKER);
  });

  it("仅 database 未设置 → 追加引导句", () => {
    const config = defaultConfig();
    config.using_mcp_name = "dbx";
    expect(buildSection(config, "prod", null).endsWith(UNSET_GUIDANCE)).toBe(true);
  });

  it("空字符串视为未设置 → 追加引导句", () => {
    const config = defaultConfig();
    config.using_mcp_name = "dbx";
    expect(buildSection(config, "prod", "").endsWith(UNSET_GUIDANCE)).toBe(true);
  });
});

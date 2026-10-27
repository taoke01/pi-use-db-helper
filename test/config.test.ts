import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PROMPT, configFilePath, defaultConfig, loadConfig, repairConfig, saveConfig } from "../src/config.ts";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pudh-test-"));
}

describe("config: 生成与读取", () => {
  it("文件缺失 → 生成默认配置（status=generated），三键为空", () => {
    const home = tmpHome();
    const result = loadConfig(home);
    expect(result.status).toBe("generated");
    expect(result.config).toEqual(defaultConfig());
    expect(fs.existsSync(configFilePath(home))).toBe(true);
  });

  it("再次读取同一目录 → status=ok 且内容一致", () => {
    const home = tmpHome();
    loadConfig(home);
    const again = loadConfig(home);
    expect(again.status).toBe("ok");
    expect(again.config).toEqual(defaultConfig());
  });

  it("saveConfig 回填后可读回", () => {
    const home = tmpHome();
    const config = defaultConfig();
    config.using_mcp_name = "dbx";
    saveConfig(config, home);
    const result = loadConfig(home);
    expect(result.status).toBe("ok");
    expect(result.config.using_mcp_name).toBe("dbx");
  });
});

describe("config: JSON 损坏容错（3.5）", () => {
  it("损坏文件 → 备份 .bakyyyyMMdd 并重建默认配置（status=corrupted）", () => {
    const home = tmpHome();
    const filePath = configFilePath(home);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ not valid json !!!", "utf-8");
    const result = loadConfig(home);
    expect(result.status).toBe("corrupted");
    expect(result.backupPath).toMatch(/pudh\.json\.bak\d{8}$/);
    expect(fs.existsSync(result.backupPath ?? "")).toBe(true);
    expect(fs.readFileSync(result.backupPath ?? "", "utf-8")).toBe("{ not valid json !!!");
    expect(result.config).toEqual(defaultConfig());
  });
});

describe("config: 键缺失容错（3.6）", () => {
  it("缺 default_prompt → 回填默认模板（status=repaired）", () => {
    const [config, repaired] = repairConfig({ using_mcp_name: "dbx" });
    expect(repaired).toBe(true);
    expect(config.default_prompt).toBe(DEFAULT_PROMPT);
    expect(config.using_mcp_name).toBe("dbx");
  });

  it("键类型错误 → 按缺失处理补齐", () => {
    const [config, repaired] = repairConfig({ using_mcp_name: 42, default_prompt: "x" });
    expect(repaired).toBe(true);
    expect(config.using_mcp_name).toBe("");
    expect(config.default_prompt).toBe("x");
  });

  it("完整合法配置 → 不标记 repaired", () => {
    const [config, repaired] = repairConfig({ ...defaultConfig(), using_mcp_name: "dbx" });
    expect(repaired).toBe(false);
    expect(config.using_mcp_name).toBe("dbx");
  });

  it("raw 非对象 → 全默认且标记 repaired", () => {
    const [config, repaired] = repairConfig("garbage");
    expect(repaired).toBe(true);
    expect(config).toEqual(defaultConfig());
  });
});

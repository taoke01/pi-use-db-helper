import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandEnvRefs, expandServerEnvRefs, findServerConfig, findServerInRaw } from "../src/mcp-config.ts";
import { projectMcpJsonPath, userMcpJsonPath } from "../src/mcp-config.ts";

describe("mcp-config: findServerInRaw", () => {
  it("标准 mcpServers 包裹", () => {
    const raw = { mcpServers: { dbx: { command: "npx", args: ["-y", "dbx-mcp"] } } };
    expect(findServerInRaw(raw, "dbx")).toEqual({ command: "npx", args: ["-y", "dbx-mcp"] });
  });

  it("顶层直写容错", () => {
    const raw = { dbx: { url: "http://x" } };
    expect(findServerInRaw(raw, "dbx")).toEqual({ url: "http://x" });
  });

  it("namespace 规范化变体兼容（- 与 _ 互换）", () => {
    const raw = { mcpServers: { "dbx-prod": { url: "http://x" } } };
    expect(findServerInRaw(raw, "dbx_prod")).toEqual({ url: "http://x" });
    const raw2 = { mcpServers: { dbx_prod: { url: "http://x" } } };
    expect(findServerInRaw(raw2, "dbx-prod")).toEqual({ url: "http://x" });
  });

  it("未命中 / 非对象 → undefined", () => {
    expect(findServerInRaw({ mcpServers: { other: {} } }, "dbx")).toBeUndefined();
    expect(findServerInRaw("garbage", "dbx")).toBeUndefined();
    expect(findServerInRaw(null, "dbx")).toBeUndefined();
  });
});

describe("mcp-config: expandEnvRefs", () => {
  it("已定义变量 → 替换", () => {
    expect(expandEnvRefs("token=${MY_TOKEN}", { MY_TOKEN: "abc" })).toBe("token=abc");
  });

  it("未定义变量 → 保留原样", () => {
    expect(expandEnvRefs("token=${MISSING_VAR}", {})).toBe("token=${MISSING_VAR}");
  });

  it("非变量格式（!cmd、${小写开头合法}）处理", () => {
    expect(expandEnvRefs("keep !cmd as-is", {})).toBe("keep !cmd as-is");
    expect(expandEnvRefs("${lower_ok}", { lower_ok: "v" })).toBe("v");
    expect(expandEnvRefs("${1bad}", {})).toBe("${1bad}");
  });
});

describe("mcp-config: expandServerEnvRefs", () => {
  it("递归展开 command/args/env/url/headers", () => {
    const env = { T: "t", U: "http://u" };
    const entry = expandServerEnvRefs(
      { command: "run ${T}", args: ["a", "${T}"], env: { K: "${T}" }, url: "${U}/mcp", headers: { H: "${T}" } },
      env,
    );
    expect(entry.command).toBe("run t");
    expect(entry.args).toEqual(["a", "t"]);
    expect(entry.env).toEqual({ K: "t" });
    expect(entry.url).toBe("http://u/mcp");
    expect(entry.headers).toEqual({ H: "t" });
  });

  it("展开 OAuth 客户端配置中的环境变量", () => {
    const entry = expandServerEnvRefs(
      {
        url: "https://example.com/mcp",
        oauth: {
          clientId: "${OAUTH_CLIENT_ID}",
          clientSecret: "${OAUTH_CLIENT_SECRET}",
          callbackUrl: "${OAUTH_CALLBACK}",
          authServerMetadataUrl: "${OAUTH_METADATA}",
          callbackPort: 8765,
        },
      },
      {
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
        OAUTH_CALLBACK: "http://127.0.0.1:8765/callback",
        OAUTH_METADATA: "https://example.com/.well-known/oauth-authorization-server",
      },
    );
    expect(entry.oauth).toEqual({
      clientId: "client",
      clientSecret: "secret",
      callbackUrl: "http://127.0.0.1:8765/callback",
      authServerMetadataUrl: "https://example.com/.well-known/oauth-authorization-server",
      callbackPort: 8765,
    });
  });
});

describe("mcp-config: findServerConfig（通道二配置源）", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pudh-mcp-"));
  }

  function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
  }

  it("项目级 .pi/mcp.json 优先于用户级", () => {
    const cwd = tmpDir();
    const home = tmpDir();
    writeJson(projectMcpJsonPath(cwd), { mcpServers: { dbx: { command: "project-cmd" } } });
    writeJson(userMcpJsonPath(home), { mcpServers: { dbx: { command: "user-cmd" } } });
    expect(findServerConfig(cwd, "dbx", home)?.command).toBe("project-cmd");
  });

  it("项目无 → 用户级兜底", () => {
    const cwd = tmpDir();
    const home = tmpDir();
    writeJson(userMcpJsonPath(home), { mcpServers: { dbx: { command: "user-cmd" } } });
    expect(findServerConfig(cwd, "dbx", home)?.command).toBe("user-cmd");
  });

  it("均未命中 → undefined（8#16 降级）", () => {
    const cwd = tmpDir();
    const home = tmpDir();
    expect(findServerConfig(cwd, "dbx", home)).toBeUndefined();
  });

  it("命中后展开环境变量引用", () => {
    const cwd = tmpDir();
    const home = tmpDir();
    writeJson(projectMcpJsonPath(cwd), { mcpServers: { dbx: { command: "npx ${PUDH_BIN}" } } });
    const result = findServerConfig(cwd, "dbx", home);
    expect(result?.command).toBe(process.env.PUDH_BIN !== undefined ? `npx ${process.env.PUDH_BIN}` : "npx ${PUDH_BIN}");
  });

  it("文件 JSON 损坏 → 视为未命中", () => {
    const cwd = tmpDir();
    const home = tmpDir();
    fs.mkdirSync(path.dirname(projectMcpJsonPath(cwd)), { recursive: true });
    fs.writeFileSync(projectMcpJsonPath(cwd), "{ broken", "utf-8");
    expect(findServerConfig(cwd, "dbx", home)).toBeUndefined();
  });
});

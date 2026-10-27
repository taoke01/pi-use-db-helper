import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { DirectMcpClientGateway } from "../src/gateway.ts";
import { FileMcpOAuthStateStore, oauthCredentialsPath } from "../src/oauth.ts";

const temporaryDirectories: string[] = [];

function tmpDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pudh-oauth-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FileMcpOAuthStateStore", () => {
  it("按 server 名与 URL 持久化并隔离凭证", async () => {
    const filePath = path.join(tmpDir(), "oauth.json");
    const serverUrl = "http://example.com/mcp";
    const store = new FileMcpOAuthStateStore(filePath, "dbx", serverUrl);
    const state: McpOAuthState = {
      serverUrl,
      tokens: { access_token: "secret", token_type: "Bearer", refresh_token: "refresh" },
    };
    await store.save(state);

    expect(await store.load()).toEqual(state);
    expect(await new FileMcpOAuthStateStore(filePath, "other", serverUrl).load()).toBeUndefined();
    expect(await new FileMcpOAuthStateStore(filePath, "dbx", "http://example.com/other").load()).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("损坏文件给出明确错误，不静默覆盖凭证", async () => {
    const filePath = path.join(tmpDir(), "oauth.json");
    fs.writeFileSync(filePath, "{broken", "utf-8");
    const store = new FileMcpOAuthStateStore(filePath, "dbx", "http://example.com/mcp");
    await expect(store.load()).rejects.toThrow("OAuth 凭证文件损坏");
  });
});

interface FakeOAuthMcpServer {
  url: string;
  authorizationCount: () => number;
  refreshCount: () => number;
  revokeAccessTokens: () => void;
  close: () => Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** 本地实现 OAuth + Streamable HTTP MCP 的最小协议面，测试使用真实 pi-mcp 流程。 */
async function startFakeOAuthMcpServer(): Promise<FakeOAuthMcpServer> {
  let baseUrl = "";
  let accessCounter = 0;
  let refreshCounter = 0;
  let authorizationCounter = 0;
  const validAccessTokens = new Set<string>();

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", baseUrl);

      if (method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(response, {
          resource: `${baseUrl}/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ["server.default"],
        });
        return;
      }
      if (
        method === "GET" &&
        (url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
          url.pathname.startsWith("/.well-known/openid-configuration") ||
          url.pathname === "/.well-known/openid-configuration")
      ) {
        json(response, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (method === "POST" && url.pathname === "/register") {
        const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
        json(response, { ...metadata, client_id: "dynamic-test-client" }, 201);
        return;
      }
      if (method === "GET" && url.pathname === "/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        const codeChallenge = url.searchParams.get("code_challenge");
        if (
          !redirectUri ||
          !state ||
          !codeChallenge ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          url.searchParams.get("scope") !== "mcp.read"
        ) {
          json(response, { error: "invalid_request" }, 400);
          return;
        }
        authorizationCounter += 1;
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "test-authorization-code");
        callback.searchParams.set("state", state);
        response.writeHead(302, { location: callback.href });
        response.end();
        return;
      }
      if (method === "POST" && url.pathname === "/token") {
        const params = new URLSearchParams(await readBody(request));
        const grantType = params.get("grant_type");
        if (grantType === "authorization_code") {
          if (params.get("code") !== "test-authorization-code" || !params.get("code_verifier")) {
            json(response, { error: "invalid_grant" }, 400);
            return;
          }
        } else if (grantType === "refresh_token") {
          if (params.get("refresh_token") !== `refresh-${refreshCounter + 1}`) {
            json(response, { error: "invalid_grant" }, 400);
            return;
          }
          refreshCounter += 1;
        } else {
          json(response, { error: "unsupported_grant_type" }, 400);
          return;
        }
        accessCounter += 1;
        validAccessTokens.add(`access-${accessCounter}`);
        json(response, {
          access_token: `access-${accessCounter}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `refresh-${refreshCounter + 1}`,
          scope: "mcp.read",
        });
        return;
      }

      if (url.pathname === "/mcp") {
        const authorization = request.headers.authorization;
        if (authorization === undefined || !validAccessTokens.has(authorization.replace(/^Bearer /, ""))) {
          response.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
          });
          response.end("Unauthorized");
          return;
        }
        if (method === "GET") {
          response.writeHead(405).end();
          return;
        }
        if (method === "DELETE") {
          response.writeHead(200).end();
          return;
        }
        const message = JSON.parse(await readBody(request)) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "initialize") {
          json(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fake-oauth-mcp", version: "1.0.0" },
            },
          });
          return;
        }
        if (message.method === "tools/list") {
          json(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                { name: "list_connections", inputSchema: { type: "object", properties: {} } },
                { name: "list_databases", inputSchema: { type: "object", properties: {} } },
              ],
            },
          });
          return;
        }
        if (message.method === "tools/call") {
          const tool = message.params?.name;
          const names = tool === "list_connections" ? ["prod", "dev"] : ["main", "analytics"];
          json(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(names) }] },
          });
          return;
        }
        json(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        return;
      }

      json(response, { error: "not_found" }, 404);
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: `${baseUrl}/mcp`,
    authorizationCount: () => authorizationCounter,
    refreshCount: () => refreshCounter,
    revokeAccessTokens: () => validAccessTokens.clear(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("DirectMcpClientGateway HTTP + OAuth", () => {
  it(
    "完成浏览器授权直连，并在重连后用 refresh token 自动换发令牌",
    async () => {
      const fake = await startFakeOAuthMcpServer();
      const cwd = tmpDir();
      const home = tmpDir();
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, ".pi", "mcp.json"),
        JSON.stringify({
          mcpServers: { dbx: { type: "http", url: fake.url, oauth: { clientName: "pudh-test", scope: "mcp.read" } } },
        }),
        "utf-8",
      );
      const openedUrls: string[] = [];
      const openUrl = async (url: string): Promise<void> => {
        openedUrls.push(url);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`authorization failed: ${response.status}`);
        }
      };
      const first = new DirectMcpClientGateway(cwd, "dbx", "list_connections", "list_databases", home, {
        openUrl,
        oauthCallbackTimeoutMs: 3_000,
      });
      let second: DirectMcpClientGateway | undefined;
      try {
        expect(await first.checkReady()).toEqual({ ok: true });
        expect(await first.listConnections()).toEqual(["prod", "dev"]);
        expect(await first.listDatabases("prod")).toEqual(["main", "analytics"]);
        expect(openedUrls).toHaveLength(1);
        expect(fake.authorizationCount()).toBe(1);
        expect(fs.existsSync(oauthCredentialsPath(home))).toBe(true);

        await first.dispose();
        fake.revokeAccessTokens();
        second = new DirectMcpClientGateway(cwd, "dbx", "list_connections", "list_databases", home, {
          openUrl: () => {
            throw new Error("刷新令牌时不应再次打开浏览器");
          },
          oauthCallbackTimeoutMs: 3_000,
        });
        expect(await second.checkReady()).toEqual({ ok: true });
        expect(fake.refreshCount()).toBe(1);
        expect(fake.authorizationCount()).toBe(1);
      } finally {
        await first.dispose();
        await second?.dispose();
        await fake.close();
      }
    },
    15_000,
  );
});

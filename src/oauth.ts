/**
 * HTTP MCP 的 OAuth 支持。
 *
 * OAuth 协议流程由 @earendil-works/pi-mcp/oauth 提供；本模块只负责：
 * - 扩展独立凭证文件的持久化；
 * - loopback 回调服务与浏览器授权；
 * - 将 mcp.json 的 oauth 配置适配到公开 OAuth API。
 *
 * 不读取或修改 pi 内部的 mcp-auth.json，避免与 pi 自身的刷新流程竞争旋转令牌。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  parseWwwAuthenticate,
  stepUpScope,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthChallenge,
  type OAuthFlowOptions,
} from "@earendil-works/pi-mcp/oauth";
import { configDir } from "./config.ts";
import type { McpOAuthEntry } from "./types.ts";

export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** 扩展独立 OAuth 凭证文件。 */
export function oauthCredentialsPath(home?: string): string {
  return path.join(configDir(home), "oauth.json");
}

interface OAuthCredentialFile {
  version: 1;
  servers: Record<string, McpOAuthState>;
}

const fileWriteQueues = new Map<string, Promise<void>>();

function emptyCredentialFile(): OAuthCredentialFile {
  return { version: 1, servers: {} };
}

function readCredentialFile(filePath: string): OAuthCredentialFile {
  if (!fs.existsSync(filePath)) {
    return emptyCredentialFile();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    throw new Error(`OAuth 凭证文件损坏，请修复或删除后重试：${filePath}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`OAuth 凭证文件格式非法：${filePath}`);
  }
  const servers = (raw as Record<string, unknown>).servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`OAuth 凭证文件格式非法：${filePath}`);
  }
  return { version: 1, servers: servers as Record<string, McpOAuthState> };
}

/** 原子写入，避免进程中断留下半个 JSON 文件。 */
function writeCredentialFile(filePath: string, value: OAuthCredentialFile): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/**
 * 按 server 名和 URL 隔离的文件凭证存储。
 * 同一进程内的跨 provider 写入也会排队；读取会等待已排队的写入完成。
 */
export class FileMcpOAuthStateStore implements McpOAuthStateStore {
  private readonly serverUrl: string;
  private readonly key: string;

  constructor(
    private readonly filePath: string,
    serverName: string,
    serverUrl: string,
  ) {
    this.serverUrl = new URL(serverUrl).href;
    this.key = JSON.stringify([serverName, this.serverUrl]);
  }

  async load(): Promise<McpOAuthState | undefined> {
    await fileWriteQueues.get(this.filePath)?.catch(() => undefined);
    const state = readCredentialFile(this.filePath).servers[this.key];
    if (state === undefined || state.serverUrl !== this.serverUrl) {
      return undefined;
    }
    return structuredClone(state);
  }

  async save(state: McpOAuthState): Promise<void> {
    if (state.serverUrl !== this.serverUrl) {
      throw new Error("OAuth 凭证的 server URL 不匹配，已拒绝写入");
    }
    const previous = fileWriteQueues.get(this.filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      const file = readCredentialFile(this.filePath);
      file.servers[this.key] = structuredClone(state);
      writeCredentialFile(this.filePath, file);
    });
    fileWriteQueues.set(this.filePath, next);
    try {
      await next;
    } finally {
      if (fileWriteQueues.get(this.filePath) === next) {
        fileWriteQueues.delete(this.filePath);
      }
    }
  }
}

export interface HttpOAuthOptions {
  serverName: string;
  serverUrl: string;
  oauth?: McpOAuthEntry;
  home?: string;
  /** 展示授权 URL，供无法自动打开浏览器时手动访问。 */
  onAuthorizationUrl?: (url: string) => void;
  /** 测试或宿主可注入浏览器打开方式。 */
  openUrl?: (url: string) => void | Promise<void>;
  callbackTimeoutMs?: number;
}

/** 打开系统浏览器；只等待进程成功启动，不等待浏览器退出。 */
export async function openUrlInBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
  child.unref();
}

function registeredRedirectUrl(state: McpOAuthState | undefined): string | undefined {
  const information = state?.clientInformation;
  if (information !== undefined && "redirect_uris" in information && Array.isArray(information.redirect_uris)) {
    return information.redirect_uris.find((value): value is string => typeof value === "string" && value !== "");
  }
  return undefined;
}

function loopbackListenOptions(
  redirectUrl: string,
  fallbackPort: number | undefined,
  timeoutMs: number,
): { host: string; redirectHost: string; port: number; path: string; timeoutMs: number } {
  const url = new URL(redirectUrl);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(`OAuth callbackUrl 必须是 loopback HTTP 地址：${redirectUrl}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("OAuth callbackUrl 不能包含 query 或 hash");
  }
  const port = url.port === "" ? (fallbackPort ?? 0) : Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`OAuth 回调端口非法：${url.port}`);
  }
  return {
    host: hostname,
    redirectHost: hostname,
    port,
    path: url.pathname === "" ? "/callback" : url.pathname,
    timeoutMs,
  };
}

/**
 * 一个 HTTP client 生命周期内复用的 OAuth 会话。
 * provider、回调端口和授权状态保持一致，授权完成后可用同一 provider 重连。
 */
export class HttpOAuthSession {
  readonly authProvider: AuthProvider;
  private readonly provider: McpOAuthProvider;
  private authorizationUrl: URL | undefined;
  private challenge: OAuthChallenge | undefined;
  private closed = false;

  private constructor(
    private readonly options: HttpOAuthOptions,
    private readonly callback: OAuthCallbackServer,
    store: FileMcpOAuthStateStore,
  ) {
    this.provider = new McpOAuthProvider({
      serverUrl: options.serverUrl,
      redirectUrl: callback.redirectUrl,
      clientMetadata: {
        client_name: options.oauth?.clientName ?? "pi-use-db-helper",
        scope: options.oauth?.scope,
      },
      clientId: options.oauth?.clientId,
      clientSecret: options.oauth?.clientSecret,
      store,
      onRedirect: (url) => {
        this.authorizationUrl = url;
      },
    });
    this.authProvider = {
      token: async () => (await this.provider.tokens())?.access_token,
      onUnauthorized: async (context) => {
        this.challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
        throw new McpOAuthAuthorizationRequiredError();
      },
    };
  }

  static async create(options: HttpOAuthOptions): Promise<HttpOAuthSession> {
    if (options.oauth?.clientRegistration === "cimd") {
      throw new Error('HTTP 直连暂不支持 oauth.clientRegistration: "cimd"，请使用 dcr 或预注册 clientId');
    }
    const store = new FileMcpOAuthStateStore(
      oauthCredentialsPath(options.home),
      options.serverName,
      options.serverUrl,
    );
    const stored = await store.load();
    const hasFixedRedirect = options.oauth?.callbackUrl !== undefined || options.oauth?.callbackPort !== undefined;
    const redirectUrl =
      options.oauth?.callbackUrl ??
      (options.oauth?.callbackPort !== undefined
        ? `http://127.0.0.1:${options.oauth.callbackPort}/callback`
        : (registeredRedirectUrl(stored) ?? "http://127.0.0.1:0/callback"));
    const timeoutMs = options.callbackTimeoutMs ?? DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS;
    let callback: OAuthCallbackServer;
    let mustReregister = false;
    try {
      callback = await OAuthCallbackServer.listen(loopbackListenOptions(redirectUrl, options.oauth?.callbackPort, timeoutMs));
    } catch (error) {
      // 动态注册使用的旧随机端口可能被其他进程占用；换端口并重新注册客户端。
      if (hasFixedRedirect || registeredRedirectUrl(stored) === undefined) {
        throw error;
      }
      callback = await OAuthCallbackServer.listen({ timeoutMs });
      mustReregister = true;
    }
    const session = new HttpOAuthSession(options, callback, store);
    if (mustReregister) {
      await session.provider.invalidateCredentials("client");
    }
    return session;
  }

  private flowOptions(): OAuthFlowOptions {
    return {
      serverUrl: this.options.serverUrl,
      resourceMetadataUrl: this.challenge?.resourceMetadataUrl,
      scope: this.options.oauth?.scope ?? this.challenge?.scope,
      authorizationServerMetadataUrl:
        this.options.oauth?.authServerMetadataUrl === undefined ? undefined : new URL(this.options.oauth.authServerMetadataUrl),
    };
  }

  /** 优先刷新令牌；需要用户授权时打开浏览器并完成 loopback 回调。 */
  async completeAuthorization(): Promise<void> {
    const flowOptions = this.flowOptions();
    if (this.challenge?.error === "insufficient_scope") {
      const granted = await this.provider.tokens();
      flowOptions.scope = this.options.oauth?.scope ?? stepUpScope(granted?.scope, this.challenge.scope);
      flowOptions.skipRefresh = true;
    }
    const initial = await authorizeMcp(this.provider, flowOptions);
    if (initial === "AUTHORIZED") {
      this.challenge = undefined;
      return;
    }
    const authorizationUrl = this.authorizationUrl;
    if (authorizationUrl === undefined) {
      throw new Error("MCP 要求 OAuth 授权，但未获得授权 URL");
    }
    const state = await this.provider.state();
    const callbackResult = this.callback.waitForCallback(state);
    this.options.onAuthorizationUrl?.(authorizationUrl.href);
    try {
      await (this.options.openUrl ?? openUrlInBrowser)(authorizationUrl.href);
    } catch {
      // 已展示 URL；浏览器无法自动打开时仍允许用户手动完成授权。
    }
    const { code, iss } = await callbackResult;
    await authorizeMcp(this.provider, { ...flowOptions, authorizationCode: code, iss });
    this.authorizationUrl = undefined;
    this.challenge = undefined;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.callback.close();
  }
}

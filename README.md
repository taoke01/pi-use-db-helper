# pi-use-db-helper

一个用于 [pi](https://github.com/earendil-works/pi) 的数据库连接上下文扩展：在每轮系统提示词中注入当前 MCP、数据库连接和 database，并提供两层交互式选择器。

## 功能

- 自动甄别可提供连接列表和 database 列表的数据库类 MCP。
- 通过 `/pudh-set` 手动选择连接与 database。
- HTTP MCP 支持 OAuth 浏览器授权、loopback 回调、令牌持久化与自动刷新。
- 通过 `pudh_setup_connection` 工具让 agent 引导用户完成选择。
- 选择结果按会话保存，恢复会话后自动还原。
- 在状态栏显示当前连接与 database。

## 环境要求

- pi 1.4.0 或兼容版本。
- Node.js 22.19.0 或更高版本（与当前 pi 运行时要求一致）。
- 至少配置一个数据库类 MCP，并提供“列出连接”和“列出 database”两个工具。

## 使用 pi 命令行安装

### 从本地目录安装

在本项目目录执行：

```bash
npm install
pi install .
```

也可以从其他目录传入本项目的绝对路径：

```bash
pi install /absolute/path/to/pi-use-db-helper
```

本地目录会以原路径加载，不会复制到 pi 的 npm 包目录；本地安装前需要自行执行 `npm install` 安装依赖。

### 从 Git 安装

将仓库推送到 Git 托管服务并创建版本标签后执行（替换为实际仓库地址和标签）：

```bash
pi install git:github.com/<owner>/pi-use-db-helper@v1.0.0
```

pi 会克隆仓库、安装运行时依赖并加载清单中声明的扩展。

### 从 npm 安装

本项目已包含 npm 发布所需的 `pi` 清单和运行时依赖声明。发布到 npm 后执行：

```bash
pi install npm:pi-use-db-helper@1.0.0
```

> 上述 npm 命令需要先由维护者执行 `npm publish`；这里不表示该包已经发布。

### 临时试用（不写入配置）

```bash
pi -e /absolute/path/to/pi-use-db-helper
```

## 安装后确认

```bash
pi list
```

重新启动 pi，或在已打开的交互会话中执行 `/reload`。也可以使用 `pi config` 检查扩展资源是否启用。

首次会话会在以下位置生成配置：

```text
~/.pi/agent/pi-use-db-helper/pudh.json
```

随后扩展会甄别数据库类 MCP 并回填配置。配置完成后，在交互会话中执行：

```text
/pudh-set
```

依次选择连接和 database，并确认。agent 执行数据库任务时，也会根据提示词引导调用 `pudh_setup_connection`。

## HTTP + OAuth 直连

对于未配置静态 `Authorization` header 的 HTTP MCP，`/pudh-set` 会在服务器返回 401 后直接启动 OAuth，无需经过 agent：

1. 发现受保护资源和授权服务器元数据。
2. 使用动态客户端注册，或 `mcp.json` 中预注册的 `clientId`/`clientSecret`。
3. 启动 loopback 回调服务并打开系统浏览器；终端同时显示授权 URL，便于手动打开。
4. 使用 PKCE 完成授权码交换，保存令牌并重连 MCP。
5. 后续连接遇到令牌失效时自动使用 refresh token；刷新失败时可重新授权。

支持 pi 的 `oauth` 配置字段：`clientId`、`clientSecret`、`callbackPort`、`callbackUrl`、`scope`、`clientName` 和 `authServerMetadataUrl`。例如：

```json
{
  "mcpServers": {
    "dbx": {
      "type": "http",
      "url": "https://example.com/mcp",
      "oauth": {
        "clientId": "my-client",
        "clientSecret": "${MCP_OAUTH_CLIENT_SECRET}",
        "callbackUrl": "http://127.0.0.1:8765/callback",
        "scope": "mcp.read"
      }
    }
  }
}
```

凭证独立保存在：

```text
~/.pi/agent/pi-use-db-helper/oauth.json
```

扩展不读取或修改 pi 内部的 `mcp-auth.json`，避免两个客户端竞争刷新同一组旋转令牌。因此，即使已经执行过 `/mcp login`，首次通过本扩展直连时仍需单独授权一次。

当前不支持 `oauth.clientRegistration: "cimd"`；请使用默认的 `dcr` 或预注册 `clientId`。显式配置了 `Authorization` header 的 HTTP MCP 会继续使用该静态认证，不进入 OAuth。

## 更新与卸载

```bash
pi update --extensions
pi remove /absolute/path/to/pi-use-db-helper
```

`pi remove` 的 source 应与安装时使用的包来源一致；npm 和 Git 安装分别使用对应的 npm 或 Git source。

## 开发

```bash
npm install
npm test
npm run typecheck
npm pack --dry-run
```

扩展入口为 `src/index.ts`，由 `package.json` 中的 `pi.extensions` 显式声明。pi 通过 jiti 直接加载 TypeScript，无需构建。

宿主提供的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 声明为 `peerDependencies`；`@modelcontextprotocol/sdk` 用于 stdio 直连，`@earendil-works/pi-mcp` 用于 HTTP 传输与 OAuth 流程。

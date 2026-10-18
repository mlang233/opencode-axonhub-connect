# opencode-axonhub-connect

[English](README.en.md) | 中文

OpenCode V2 插件，用于连接 [AxonHub](https://github.com/looplj/axonhub)。通过 OpenCode 原生的 `/connect` 流程配置 AxonHub 地址和 API Key，自动发现模型，并按模型所属协议路由请求。

## 功能

- `/connect` 直接填写 **AxonHub URL + API Key**，无需在 `opencode.json` 里配置 `baseURL` 或 `apiKey`。
- 从 `/v1/models` 和 `/v1/models?include=all` 自动发现模型。
- 按协议路由模型：
  - OpenAI 模型 → OpenAI **Responses API**（`/v1`）
  - Gemini 模型 → Google Gemini API（`/gemini/v1beta`）
  - Claude 模型 → Anthropic Messages API（`/anthropic/v1`）
  - 其他模型 → OpenAI 兼容 Chat Completions（`/v1`）
- 凭据变化后自动刷新模型列表。
- API Key 保存在 OpenCode 凭据库中，不写入仓库或配置文件。

## 环境要求

- OpenCode V2
- 可访问的 AxonHub 实例
- AxonHub API Key

## 安装

使用 OpenCode 插件安装命令：

```sh
opencode plugin add github:mlang233/opencode-axonhub-connect
```

如果需要固定版本：

```sh
opencode plugin add github:mlang233/opencode-axonhub-connect#v0.1.1
```

然后连接：

```text
/connect
# 选择 AxonHub
# AxonHub URL: https://your-axonhub.example.com
# API Key: ah-...
```

最后：

```text
/models
```

模型会以 `axonhub/` 为前缀出现，例如 `axonhub/gpt-6-sol`。

## 模型协议路由

| 模型类型 | 识别方式 | OpenCode package | AxonHub 端点 |
| --- | --- | --- | --- |
| OpenAI | `owned_by=openai`、`gpt-*`、`o1`–`o9`、`codex*` | `@opencode/ai/providers/openai/responses` | `/v1`（Responses API） |
| Gemini | `owned_by=google`/`gemini`、`gemini-*` | `@opencode/ai/providers/google` | `/gemini/v1beta` |
| Claude | `owned_by=anthropic`、`claude*` | `@opencode/ai/providers/anthropic` | `/anthropic/v1` |
| 其他 | 其他所有模型 | `@opencode/ai/providers/openai-compatible` | `/v1`（Chat Completions） |

AxonHub URL 填根地址，不要带 `/v1`。即使误带了 `/v1`，插件也会自动去掉。

## 非交互配置

推荐使用 `/connect`。在无法交互的环境中，也可以使用插件 options 和环境变量：

```jsonc
{
  "plugins": [
    {
      "package": "github:mlang233/opencode-axonhub-connect",
      "options": {
        "baseURL": "https://axonhub.example.com"
      }
    }
  ]
}
```

```sh
export AXONHUB_BASE_URL="https://axonhub.example.com"
export AXONHUB_API_KEY="ah-..."
```

解析顺序：

- URL：插件 option → `/connect` 保存的凭据 → `AXONHUB_BASE_URL`
- Key：插件 option → `/connect` 保存的凭据 → `AXONHUB_API_KEY`

## 工作原理

插件注册一个名为 `axonhub` 的 integration，使用 key 认证方式。key 认证表单里包含 `axonhubBaseURL` 字段，OpenCode 会把 URL 和 API Key 一起保存到凭据配置中。

字段故意不叫 `baseURL`：OpenCode 会把凭据里的 `configuration.baseURL` 当成 provider 级地址，从而覆盖每个模型自己的端点。使用 `axonhubBaseURL` 可以让模型发现和按模型路由互不干扰。

插件在启动时以及凭据变化时拉取模型列表，然后注册 `axonhub` provider，并为每个模型设置对应的 package 和 endpoint。请求强制使用 HTTP transport，避免网关不支持 WebSocket 时卡住。

## 安全

- API Key 由 OpenCode 凭据库保存。
- 插件不会把 Key 写入 `opencode.json` 或仓库。
- 如果使用环境变量方式，请把变量配置到 OpenCode 服务进程中，例如使用 `opencode service set env`。

## 开发

```sh
npm install
npm run check
```

## 许可证

MIT

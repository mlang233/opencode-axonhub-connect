# opencode-axonhub-connect

[中文](README.md) | English

OpenCode V2 plugin for [AxonHub](https://github.com/looplj/axonhub). It configures the AxonHub URL and API key through OpenCode's native `/connect` flow, discovers models automatically, and routes each model through the protocol its provider expects.

## Features

- `/connect` asks for **AxonHub URL + API Key**, so no `baseURL` or `apiKey` is needed in `opencode.json`.
- Discovers models from `/v1/models` and `/v1/models?include=all`.
- Maps AxonHub model pricing into OpenCode so session cost and the footer show real amounts.
- Registers protocol-appropriate reasoning levels for capable models (OpenAI, Claude, Gemini, DeepSeek, and others), restoring thinking-effort options in the model picker.
- Routes models by protocol:
  - OpenAI models → OpenAI **Responses API** (`/v1`)
  - Gemini models → Google Gemini API (`/gemini/v1beta`)
  - Claude models → Anthropic Messages API (`/anthropic/v1`)
  - everything else → OpenAI-compatible chat completions (`/v1`)
- Refreshes the model list when the saved credential changes.
- Stores the API key in OpenCode's credential store, not in the repository or config file.

## Requirements

- OpenCode V2
- A reachable AxonHub instance
- An AxonHub API key

## Install

Use OpenCode's plugin installer:

```sh
opencode plugin add github:mlang233/opencode-axonhub-connect
```

Pin a release tag if you prefer:

```sh
opencode plugin add github:mlang233/opencode-axonhub-connect#v0.3.0
```

Then connect:

```text
/connect
# Select AxonHub
# AxonHub URL: https://your-axonhub.example.com
# API Key: ah-...
```

Finally:

```text
/models
```

Models appear under the `axonhub/` prefix, for example `axonhub/gpt-6-sol`.

## Routing

| Model type | Detection | OpenCode package | AxonHub endpoint |
| --- | --- | --- | --- |
| OpenAI | `owned_by=openai`, `gpt-*`, `o1`–`o9`, `codex*` | `@opencode/ai/providers/openai/responses` | `/v1` (Responses API) |
| Gemini | `owned_by=google`/`gemini`, `gemini-*` | `@opencode/ai/providers/google` | `/gemini/v1beta` |
| Claude | `owned_by=anthropic`, `claude*` | `@opencode/ai/providers/anthropic` | `/anthropic/v1` |
| Other | anything else | `@opencode/ai/providers/openai-compatible` | `/v1` (chat completions) |

The AxonHub URL must be the root URL without `/v1`. A trailing `/v1` is stripped automatically.

## Model pricing

`/v1/models?include=all` returns `pricing` for models that have ModelCard data (USD per 1M tokens). The plugin maps it into OpenCode's `cost`, so OpenCode can price input, output, cache read, and cache write tokens, and the session footer shows real amounts.

Notes:

- The price comes from AxonHub's model catalog (ModelCard), not the channel prices under **Channels → Model Prices**.
- The `usage.cost` AxonHub injects (based on channel prices) is not read by OpenCode; OpenCode always calculates with its local price table.
- Models without ModelCard data return no `pricing`; their `cost` stays empty and the session shows no amount.
- If channel prices differ from catalog prices, the footer amount can differ from AxonHub's usage page. Override `cost` for that model in `opencode.json` when they must match exactly.

## Configuration fallback

`/connect` is the recommended setup. For non-interactive environments, plugin options and environment variables also work:

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

Resolution order:

- URL: plugin option → saved `/connect` credential → `AXONHUB_BASE_URL`
- Key: plugin option → saved `/connect` credential → `AXONHUB_API_KEY`

## How it works

The plugin registers an `axonhub` integration with a key method. The key method includes an `axonhubBaseURL` form field, so OpenCode stores both values in the credential configuration.

The field is intentionally not named `baseURL`: OpenCode treats a credential `configuration.baseURL` as a provider-wide endpoint and would override the per-model endpoints. Using `axonhubBaseURL` keeps discovery and per-model routing independent.

On startup and on credential changes, the plugin fetches the model inventory and registers an `axonhub` provider with a per-model package and endpoint. Requests use HTTP transport to avoid provider WebSocket negotiation with gateways that do not support it.

## Security

- The API key is stored by OpenCode's credential store.
- The plugin never writes the key to `opencode.json` or the repository.
- If you use the environment fallback, set the variable in the OpenCode server environment (for example with `opencode service set env`).

## Development

```sh
npm install
npm run check
```

## License

MIT

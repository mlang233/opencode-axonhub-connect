# opencode-axonhub-connect

OpenCode V2 plugin for [AxonHub](https://github.com/looplj/axonhub). It configures the AxonHub URL and API key through OpenCode's native `/connect` flow, discovers models automatically, and routes each model through the protocol its provider expects.

## Features

- `/connect` asks for **AxonHub URL + API Key**, so no `baseURL` or `apiKey` is needed in `opencode.json`.
- Discovers models from `/v1/models` and `/v1/models?include=all`.
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
opencode plugin add github:mlang233/opencode-axonhub-connect#v0.1.0
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

The plugin registers an `axonhub` integration with a key method. The key method includes a `baseURL` form field, so OpenCode stores both values in the credential configuration. On startup and on credential changes, the plugin fetches the model inventory and registers an `axonhub` provider with a per-model package and endpoint.

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

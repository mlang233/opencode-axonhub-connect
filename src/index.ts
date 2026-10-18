import { Plugin } from "@opencode/plugin"

const PROVIDER_ID = "axonhub"
const INTEGRATION_ID = "axonhub"
const ENV_BASE_URL = "AXONHUB_BASE_URL"
const ENV_KEY = "AXONHUB_API_KEY"
const DISCOVERY_TIMEOUT_MS = 15_000

type Options = {
  baseURL?: string
  apiKey?: string
}

type AxonHubModel = {
  id?: string
  name?: string
  display_name?: string
  owned_by?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: {
    vision?: boolean
    tool_call?: boolean
    toolCall?: boolean
    reasoning?: boolean
  }
}

type Route = {
  package: string
  path: string
}

type State = {
  baseURL: string
  key: string
  models: any[]
}

function normalizeBaseURL(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\/v1\/?$/, "")
    .replace(/\/+$/, "")
}

/**
 * Pick the protocol OpenCode should speak to AxonHub.
 *
 * - OpenAI models: OpenAI Responses API
 * - Gemini models: Google Gemini API
 * - Claude models: Anthropic Messages API
 * - everything else: OpenAI-compatible chat completions
 */
function routeFor(model: AxonHubModel): Route {
  const id = (model.id ?? "").toLowerCase()
  const owner = (model.owned_by ?? "").toLowerCase()

  if (owner === "google" || owner === "gemini" || id.startsWith("gemini-")) {
    return {
      package: "@opencode/ai/providers/google",
      path: "/gemini/v1beta",
    }
  }

  if (owner === "anthropic" || id.startsWith("claude")) {
    return {
      package: "@opencode/ai/providers/anthropic",
      path: "/anthropic/v1",
    }
  }

  if (
    owner === "openai" ||
    owner === "codex" ||
    id.startsWith("gpt-") ||
    id.startsWith("codex") ||
    /^o[1-9]/.test(id)
  ) {
    return {
      package: "@opencode/ai/providers/openai/responses",
      path: "/v1",
    }
  }

  return {
    package: "@opencode/ai/providers/openai-compatible",
    path: "/v1",
  }
}

async function fetchModels(baseURL: string, key: string): Promise<AxonHubModel[]> {
  const clean = normalizeBaseURL(baseURL)
  const headers = { Authorization: `Bearer ${key}` }
  const urls = [`${clean}/v1/models`, `${clean}/v1/models?include=all`]
  const responses = await Promise.all(
    urls.map((url) =>
      fetch(url, {
        headers,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      }),
    ),
  )

  const byID = new Map<string, AxonHubModel>()
  for (const response of responses) {
    if (!response.ok) continue
    const payload = (await response.json()) as { data?: AxonHubModel[] }
    for (const item of payload.data ?? []) {
      if (!item?.id) continue
      byID.set(item.id, { ...byID.get(item.id), ...item })
    }
  }

  return [...byID.values()]
}

function toModel(item: AxonHubModel, baseURL: string) {
  const id = item.id!
  const route = routeFor(item)
  const vision = item.capabilities?.vision === true

  return {
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: item.name ?? item.display_name ?? id,
    package: route.package,
    settings: {
      baseURL: normalizeBaseURL(baseURL) + route.path,
    },
    capabilities: {
      tools:
        item.capabilities?.tool_call ??
        item.capabilities?.toolCall ??
        true,
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: item.context_length ?? 200_000,
      output: item.max_output_tokens ?? 32_000,
    },
  }
}

export default Plugin.define({
  id: "opencode-axonhub-connect",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    let state: State | undefined

    const resolveCredential = async () => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      const credential = connection
        ? await ctx.integration.connection.resolve(connection)
        : undefined
      const configuration =
        credential?.type === "key" ? credential.configuration : undefined

      const configuredBaseURL =
        typeof configuration?.baseURL === "string"
          ? configuration.baseURL
          : undefined

      const baseURL = normalizeBaseURL(
        options.baseURL ??
          configuredBaseURL ??
          process.env[ENV_BASE_URL] ??
          "",
      )
      const key =
        options.apiKey ??
        (credential?.type === "key" ? credential.key : undefined) ??
        process.env[ENV_KEY]

      return {
        baseURL,
        key: key ? String(key) : undefined,
      }
    }

    await ctx.integration.transform((editor) => {
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = "AxonHub"
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          type: "key",
          label: "AxonHub URL + API Key",
          form: [
            {
              type: "string",
              key: "baseURL",
              title: "AxonHub URL",
              description:
                "AxonHub root URL, for example https://axonhub.example.com (without /v1)",
              format: "uri",
              placeholder: "https://axonhub.example.com",
              required: true,
            },
          ],
        },
      })
    })

    await ctx.provider.transform((editor) => {
      const existing = editor.get(PROVIDER_ID)
      if (!state || state.models.length === 0) {
        if (existing) editor.remove(PROVIDER_ID)
        return
      }

      editor.add({
        info: {
          id: PROVIDER_ID as any,
          name: "AxonHub",
          activation: "auto",
          integrationID: INTEGRATION_ID as any,
          package: "@opencode/ai/providers/anthropic",
          settings: { baseURL: state.baseURL, transport: "http" },
        },
        models: state.models,
      })
    })

    const refresh = async () => {
      const { baseURL, key } = await resolveCredential()
      if (!baseURL || !key) {
        state = undefined
        await ctx.provider.reload()
        return
      }

      try {
        const items = await fetchModels(baseURL, key)
        state = {
          baseURL,
          key,
          models: items.map((item) => toModel(item, baseURL)),
        }
      } catch (error) {
        console.error("[opencode-axonhub-connect] model discovery failed", error)
        state = undefined
      }

      await ctx.provider.reload()
    }

    await refresh()

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (
          event.type === "credential.updated" ||
          event.type === "credential.switched"
        ) {
          await refresh()
        }
      }
    })().catch(() => {})

    return () => controller.abort()
  },
})

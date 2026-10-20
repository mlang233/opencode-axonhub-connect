import { Plugin } from "@opencode/plugin"

const PROVIDER_ID = "axonhub"
const INTEGRATION_ID = "axonhub"
const ENV_BASE_URL = "AXONHUB_BASE_URL"
const ENV_KEY = "AXONHUB_API_KEY"
const DISCOVERY_TIMEOUT_MS = 15_000
const RETRY_INITIAL_MS = 30_000
const RETRY_MAX_MS = 5 * 60_000

type Options = {
  baseURL?: string
  apiKey?: string
}

type AxonHubPricing = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  unit?: string
  currency?: string
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
  pricing?: AxonHubPricing
}

type Route = {
  package: string
  path: string
}

type Variant = {
  id: string
  settings?: Record<string, unknown>
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

type State = {
  baseURL: string
  key: string
  models: any[]
}

const OPENAI_RESPONSES_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"]
const OPENAI_CHAT_EFFORTS = ["low", "medium", "high"]
const GOOGLE_EFFORTS = ["low", "medium", "high"]

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

/**
 * Map AxonHub's ModelCard pricing to OpenCode's model cost.
 *
 * AxonHub returns prices in USD per 1M tokens. Only models with ModelCard data
 * include a `pricing` object; channel-specific prices configured in AxonHub are
 * used by AxonHub for `usage.cost` and are not exposed by `/v1/models`.
 */
function toCost(pricing: AxonHubPricing | undefined) {
  if (!pricing) return []
  if (pricing.currency && pricing.currency.toUpperCase() !== "USD") return []
  if (pricing.unit && pricing.unit !== "per_1m_tokens") return []

  const input = Number(pricing.input ?? 0)
  const output = Number(pricing.output ?? 0)
  const read = Number(pricing.cache_read ?? 0)
  const write = Number(pricing.cache_write ?? 0)
  if (![input, output, read, write].every((value) => Number.isFinite(value))) return []
  if (input === 0 && output === 0 && read === 0 && write === 0) return []

  return [{ input, output, cache: { read, write } }]
}

function variant(id: string, settings: Record<string, unknown>): Variant {
  return { id, settings }
}

/**
 * OpenCode V2 does not infer reasoning variants from a plugin-provided model.
 * It only derives them from `capabilities.reasoning` in provider config, or
 * uses the `variants` array registered by the provider. AxonHub exposes only
 * a boolean `capabilities.reasoning`, so we spell the variants for the
 * selected protocol here.
 */
function claudeInfo(id: string) {
  // Prefer "claude-3-7-sonnet" over "claude-sonnet-4-5". The version-first
  // form is ambiguous with the date suffix on IDs such as
  // claude-3-7-sonnet-20250219.
  const versionFirst = /claude-(\d{1,2})(?:[.-](\d{1,2}))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id)
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/i.exec(id)
  const family = (versionFirst?.[3] ?? familyFirst?.[1])?.toLowerCase()
  const major = Number(versionFirst?.[1] ?? familyFirst?.[2])
  const minor = Number(versionFirst?.[2] ?? familyFirst?.[3] ?? 0)
  return { family, major, minor }
}

function claudeVariants(id: string, output: number): Variant[] {
  const info = claudeInfo(id)
  const budget = (tokens: number) => ({ thinking: { type: "enabled", budgetTokens: tokens } })
  const ceiling = Math.max(1024, output - 1)
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5
  const manual = Number.isFinite(info.major) && (info.major < 4 || (info.major === 4 && info.minor < 6))

  if (manual && !opus45) {
    const high = Math.min(16000, ceiling)
    const max = Math.min(32000, ceiling)
    return [
      variant("high", budget(high)),
      ...(max > high ? [variant("max", budget(max))] : []),
    ]
  }

  const thinking = opus45 ? budget(Math.min(16000, ceiling)) : { thinking: { type: "adaptive", display: "summarized" } }
  const efforts =
    info.major === 4 && info.minor >= 6
      ? ["low", "medium", "high", "max"]
      : ["low", "medium", "high", "xhigh", "max"]
  return efforts.map((effort) => variant(effort, { ...thinking, effort }))
}

function googleVariants(id: string, output: number): Variant[] {
  if (id.includes("2.5")) {
    const ceiling = id.includes("flash") ? 24576 : 32768
    const max = Math.min(ceiling, Math.max(1024, output - 1))
    const high = Math.min(16000, max)
    return [
      variant("high", { thinkingConfig: { includeThoughts: true, thinkingBudget: high } }),
      ...(max > high
        ? [variant("max", { thinkingConfig: { includeThoughts: true, thinkingBudget: max } })]
        : []),
    ]
  }

  return GOOGLE_EFFORTS.map((effort) =>
    variant(effort, { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }),
  )
}

function toVariants(item: AxonHubModel, route: Route, output: number): Variant[] {
  if (item.capabilities?.reasoning !== true) return []

  const id = (item.id ?? "").toLowerCase()

  if (route.package === "@opencode/ai/providers/openai/responses") {
    // GPT-6 Astra rejects `none`; GPT-6.1 rejects `none` and `minimal`.
    // Keep the levels that are accepted across the GPT-6 family.
    const efforts = id.includes("gpt-6")
      ? ["low", "medium", "high", "xhigh"]
      : OPENAI_RESPONSES_EFFORTS
    return efforts.map((effort) =>
      variant(effort, {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }),
    )
  }

  if (route.package === "@opencode/ai/providers/anthropic") {
    return claudeVariants(id, output)
  }

  if (route.package === "@opencode/ai/providers/google") {
    return googleVariants(id, output)
  }

  // DeepSeek's native levels are none/low/high/max. AxonHub accepts the
  // unified `reasoning_effort` values, so keep the same ids as the official
  // DeepSeek provider instead of the generic low/medium/high set.
  if ((item.owned_by ?? "").toLowerCase() === "deepseek" || id.includes("deepseek")) {
    return ["none", "low", "high", "max"].map((effort) =>
      variant(effort, { reasoningEffort: effort }),
    )
  }

  return OPENAI_CHAT_EFFORTS.map((effort) => variant(effort, { reasoningEffort: effort }))
}

function toModel(item: AxonHubModel, baseURL: string) {
  const id = item.id!
  const route = routeFor(item)
  const vision = item.capabilities?.vision === true
  const output = item.max_output_tokens ?? 32_000

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
    variants: toVariants(item, route, output),
    time: { released: 0 },
    cost: toCost(item.pricing),
    status: "active",
    enabled: true,
    limit: {
      context: item.context_length ?? 200_000,
      output,
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
        typeof configuration?.axonhubBaseURL === "string"
          ? configuration.axonhubBaseURL
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
              key: "axonhubBaseURL",
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
          settings: { transport: "http" },
        },
        models: state.models,
      })
    })

    const controller = new AbortController()
    let refreshPromise: Promise<void> | undefined
    let refreshQueued = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = RETRY_INITIAL_MS

    const clearRetry = () => {
      if (retryTimer === undefined) return
      clearTimeout(retryTimer)
      retryTimer = undefined
    }

    const scheduleRetry = () => {
      if (retryTimer !== undefined || controller.signal.aborted) return
      const delay = retryDelay
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void refresh().catch((error) => {
          console.error("[opencode-axonhub-connect] refresh failed", error)
        })
      }, delay)
    }

    const refreshOnce = async () => {
      if (controller.signal.aborted) return

      const { baseURL, key } = await resolveCredential()
      if (!baseURL || !key) {
        clearRetry()
        retryDelay = RETRY_INITIAL_MS
        if (!state) return
        state = undefined
        if (!controller.signal.aborted) await ctx.provider.reload()
        return
      }

      try {
        const items = await fetchModels(baseURL, key)
        if (items.length === 0) throw new Error("AxonHub returned no models")
        state = {
          baseURL,
          key,
          models: items.map((item) => toModel(item, baseURL)),
        }
        retryDelay = RETRY_INITIAL_MS
        clearRetry()
      } catch (error) {
        console.error("[opencode-axonhub-connect] model discovery failed", error)
        // Discovery failures are usually transient. Keep the last known
        // inventory so the provider does not vanish from /models; only drop
        // it when the configured endpoint changed.
        if (state?.baseURL !== baseURL) {
          state = undefined
          if (!controller.signal.aborted) await ctx.provider.reload()
        }
        scheduleRetry()
        return
      }

      if (!controller.signal.aborted) await ctx.provider.reload()
    }

    const refresh = async (): Promise<void> => {
      if (refreshPromise) {
        refreshQueued = true
        return refreshPromise
      }

      refreshPromise = (async () => {
        do {
          refreshQueued = false
          await refreshOnce()
        } while (refreshQueued && !controller.signal.aborted)
      })().finally(() => {
        refreshPromise = undefined
      })

      return refreshPromise
    }

    await refresh()

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

    return () => {
      controller.abort()
      clearRetry()
    }
  },
})

// AI Power Grid as a model provider for OpenClaw. Unofficial, community-built.
//
// The grid is a network of independent GPU operators behind one
// OpenAI-compatible API. Which models exist changes with who is online, so the
// catalog is read from the grid's public status endpoint instead of being
// written down here.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

const ID = "aipg";
const BASE_URL = "https://api.aipowergrid.io/v1";
const ENV_VAR = "AIPG_API_KEY";
const DEFAULT_MODEL = "qwen38-flash-next-nvfp4";

// An agent turn carries well over 15,000 tokens of instructions and tool
// descriptions. A model with less room than this gets a cut-off prompt.
const MIN_CONTEXT = 32000;
// The grid refuses a request above 200,000 characters (HTTP 413), whatever
// the model could hold. Advertising a window just below that makes OpenClaw
// compact the conversation before the grid turns it away.
const MAX_ADVERTISED_CONTEXT = 45000;
const MAX_OUTPUT = 8192;

const FALLBACK = [
  { name: DEFAULT_MODEL, max_context_length: 262144, pricing: { input_per_mtok_usd: 0.075, output_per_mtok_usd: 0.3 } },
];

// What tests with OpenClaw showed for single models (see README). Shown in the
// model's label so the picker says it before a turn fails.
const NOTES = {
  "gpt-oss-120b": "answers questions, but its tool calls failed in tests",
};

function toModel(m) {
  const p = m.pricing || {};
  return {
    id: m.name,
    name: `${m.name} (AI Power Grid${NOTES[m.name] ? "; " + NOTES[m.name] : ""})`,
    reasoning: false,
    input: ["text"],
    cost: {
      input: Number(p.input_per_mtok_usd) || 0,
      output: Number(p.output_per_mtok_usd) || 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: Math.min(Number(m.max_context_length) || MAX_ADVERTISED_CONTEXT, MAX_ADVERTISED_CONTEXT),
    maxTokens: MAX_OUTPUT,
  };
}

let cached = { at: 0, models: null };

// Text models that are online right now and large enough for an agent.
async function onlineModels() {
  if (cached.models && Date.now() - cached.at < 60_000) return cached.models;
  let list = FALLBACK;
  try {
    const r = await fetch(`${BASE_URL}/status/models`, {
      headers: { Accept: "application/json", "User-Agent": "openclaw-aipg-provider" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const all = await r.json();
      const fit = (Array.isArray(all) ? all : []).filter(
        (m) => m && m.type === "text" && (m.count || 0) > 0 && typeof m.name === "string" &&
          (Number(m.max_context_length) || 0) >= MIN_CONTEXT,
      );
      if (fit.length) list = fit;
    }
  } catch {
    // the grid is out of reach: keep the fallback, the request itself will say why
  }
  const models = list.map(toModel);
  // the default first, so pickers offer the model this plugin was tested with
  models.sort((a, b) => (b.id === DEFAULT_MODEL) - (a.id === DEFAULT_MODEL));
  cached = { at: Date.now(), models };
  return models;
}

export default definePluginEntry({
  id: ID,
  name: "AI Power Grid",
  description: "AI Power Grid model provider (unofficial, community-built)",
  register(api) {
    api.registerProvider({
      id: ID,
      label: "AI Power Grid",
      envVars: [ENV_VAR],

      auth: [
        createProviderApiKeyAuthMethod({
          providerId: ID,
          methodId: "api-key",
          label: "AI Power Grid API key",
          hint: "Create one at console.aipowergrid.io/dashboard/api-key (it starts with grid_)",
          optionKey: "aipgApiKey",
          flagName: "--aipg-api-key",
          envVar: ENV_VAR,
          promptMessage: "Enter your AI Power Grid API key",
          defaultModel: `${ID}/${DEFAULT_MODEL}`,
          validateApiKey: (key) =>
            /^grid_\S{8,}$/.test(String(key || "").trim())
              ? undefined
              : "That does not look like an AI Power Grid key: it starts with grid_.",
        }),
      ],

      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(ID).apiKey;
          if (!apiKey) return null;
          return {
            provider: {
              baseUrl: BASE_URL,
              apiKey,
              api: "openai-completions",
              models: await onlineModels(),
            },
          };
        },
      },

      // The set of models changes with the workers that are online; accept a
      // name that is not in the last catalog and let the grid answer.
      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: `${ctx.modelId} (AI Power Grid)`,
        provider: ID,
        api: "openai-completions",
        baseUrl: BASE_URL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 },
        contextWindow: MAX_ADVERTISED_CONTEXT,
        maxTokens: MAX_OUTPUT,
      }),
    });

    api.registerModelCatalogProvider({
      provider: ID,
      kinds: ["text"],
      liveCatalog: async () =>
        (await onlineModels()).map((m) => ({
          kind: "text",
          provider: ID,
          model: m.id,
          label: m.name,
          source: "live",
        })),
    });
  },
});

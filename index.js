// AI Power Grid as a model provider for OpenClaw. Unofficial, community-built.
//
// The grid is a network of independent GPU operators behind one
// OpenAI-compatible API. Which models exist changes with who is online, so the
// catalog is read from the grid's public status endpoint instead of being
// written down here.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { BASE_URL, CLIENT_HEADER, ENV_VAR, ID, USER_AGENT } from "./grid.js";
import { buildImageProvider } from "./images.js";
import { buildBalanceTool, buildCouncilTool } from "./tools.js";
import { buildVideoProvider } from "./video.js";
import { fundingNotes, walletSignIn } from "./wallet.js";

const WALLET_ENV_VAR = "AIPG_WALLET_PRIVATE_KEY";
const KEY_PAGE = "https://console.aipowergrid.io/?callbackUrl=%2Fdashboard%2Fapi-key";
const DEFAULT_MODEL = "qwen38-flash-next-nvfp4";

// An agent turn carries well over 15,000 tokens of instructions and tool
// descriptions. A model with less room than this gets a cut-off prompt.
const MIN_CONTEXT = 32000;
// The grid refuses a request above 200,000 characters (HTTP 413), whatever
// the model could hold. Advertising a window just below that makes OpenClaw
// compact the conversation before the grid turns it away.
// (Measured: with 45,000 one long turn was still refused once and OpenClaw
// recovered by compacting; 40,000 leaves more room for text that packs more
// tokens into fewer characters.)
const MAX_ADVERTISED_CONTEXT = 40000;
const MAX_OUTPUT = 8192;

const FALLBACK = [
  { name: DEFAULT_MODEL, max_context_length: 262144, pricing: { input_per_mtok_usd: 0.075, output_per_mtok_usd: 0.3 } },
];

// What tests with OpenClaw showed for single models (see README). Shown in the
// model's label so the picker says it before a turn fails.
// 0.6.3: gpt-oss-120b returns tool calls since the grid's fix of 2026-11-16, but in tests on
// 2026-11-17 it sometimes reported a step as done without calling the tool.
const NOTES = {
  "gpt-oss-120b": "in tests it sometimes skipped a tool step",
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
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
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
          hint: `A person has to sign in once to create it: ${KEY_PAGE} (the key starts with grid_)`,
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

        // Second way in: no browser, the account belongs to a Base wallet.
        {
          id: "wallet",
          label: "AI Power Grid wallet sign-in (Base)",
          hint: `Signs in with a Base wallet and creates the API key; the wallet key comes from ${WALLET_ENV_VAR} or a prompt and is not stored`,
          kind: "custom",
          run: async (ctx) => {
            let privateKey = String((ctx.env ?? process.env)[WALLET_ENV_VAR] || "").trim();
            if (!privateKey) {
              await ctx.prompter.note(
                `This signs one sign-in message for AI Power Grid with your wallet key. The key is used in memory and not stored; only the API key the grid returns is saved. Set ${WALLET_ENV_VAR} to skip this prompt.`,
                "AI Power Grid wallet sign-in",
              );
              privateKey = await ctx.prompter.text({ message: "Private key of the Base wallet (64 hex characters)", sensitive: true });
            }
            ctx.assertCurrent?.();
            const result = await walletSignIn({ privateKey, baseUrl: BASE_URL, clientHeader: CLIENT_HEADER, signal: ctx.signal });
            return {
              profiles: [{ profileId: `${ID}:wallet`, credential: { type: "api_key", provider: ID, key: result.apiKey } }],
              defaultModel: `${ID}/${DEFAULT_MODEL}`,
              notes: fundingNotes(result),
            };
          },
        },
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

      wrapStreamFn: (ctx) => {
        if (!ctx.streamFn) return undefined;
        const inner = ctx.streamFn;
        return (model, context, options) =>
          inner(model, context, { ...options, headers: { ...options?.headers, ...CLIENT_HEADER } });
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

    api.registerImageGenerationProvider(buildImageProvider());
    api.registerVideoGenerationProvider(buildVideoProvider());
    api.registerTool(buildBalanceTool(api));
    api.registerTool(buildCouncilTool(api));

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

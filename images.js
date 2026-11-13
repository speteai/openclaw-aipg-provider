// Image generation on AI Power Grid for OpenClaw's image_generate tool.
//
// Only the image prompt goes to the grid, so this works next to any main
// model. Plain fetch on purpose: the OpenAI-compatible image builder of the
// plugin SDK is reserved for bundled plugins.
import { isProviderApiKeyConfiguredAsync, resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";

export const IMAGE_SIZES = ["1024x1024", "1344x768", "768x1344", "1216x832", "832x1216"];
// The model this was tested with; the others are offered when they are online.
export const DEFAULT_IMAGE_MODEL = "z-image-turbo";
const KNOWN_IMAGE_MODELS = [DEFAULT_IMAGE_MODEL, "FLUX.2 Klein 4B FP8", "Krea 2 Turbo", "MOSS Image SFT BF16"];
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

function sniff(buf) {
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ["image/webp", "webp"];
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return ["image/png", "png"];
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return ["image/jpeg", "jpg"];
  return ["application/octet-stream", "bin"];
}

async function gridError(r) {
  let detail = "";
  try {
    const j = await r.json();
    const d = j && (j.detail ?? j.error);
    detail = typeof d === "string" ? d : d && d.message ? d.message : JSON.stringify(d ?? j);
  } catch {
    // no JSON body
  }
  const hint =
    r.status === 401 || r.status === 403 ? " Check the AI Power Grid API key."
    : r.status === 402 ? " The grid account has no spendable credit for this image."
    : r.status === 429 ? " The grid is rate-limiting this account; wait a minute."
    : "";
  return new Error(`AI Power Grid image generation failed (HTTP ${r.status})${detail ? ": " + detail : ""}.${hint}`);
}

export function buildImageProvider({ id, baseUrl, envVar, clientHeader, version }) {
  const apiKeyFor = async (req) =>
    (process.env[envVar] || "").trim() ||
    (await resolveProviderAuthProfileApiKey({ provider: id, cfg: req.cfg, agentDir: req.agentDir, store: req.authStore }));

  // Image models that have a worker right now, the wanted one first.
  const onlineModels = async (signal) => {
    try {
      const r = await fetch(`${baseUrl}/status/models`, { headers: { Accept: "application/json", "User-Agent": `openclaw-aipg-provider/${version}` }, signal });
      if (!r.ok) return null;
      const all = await r.json();
      return (Array.isArray(all) ? all : []).filter((m) => m && m.type === "image" && (m.count || 0) > 0).map((m) => String(m.name));
    } catch {
      return null; // unknown: let the request itself decide
    }
  };

  return {
    id,
    label: "AI Power Grid",
    defaultModel: DEFAULT_IMAGE_MODEL,
    models: [...KNOWN_IMAGE_MODELS],
    isConfiguredAsync: async (ctx) => Boolean((process.env[envVar] || "").trim()) || (await isProviderApiKeyConfiguredAsync({ provider: id, ...ctx })),
    capabilities: {
      generate: { maxCount: 4, supportsSize: true, supportsAspectRatio: false, supportsResolution: false },
      edit: { enabled: false },
      geometry: { sizes: [...IMAGE_SIZES] },
    },
    async generateImage(req) {
      if ((req.inputImages ?? []).length) throw new Error("AI Power Grid image editing is not supported by this plugin.");
      const apiKey = await apiKeyFor(req);
      if (!apiKey) throw new Error(`AI Power Grid API key missing: set ${envVar} or run "openclaw models auth paste-api-key --provider ${id}".`);
      const signal = AbortSignal.timeout(Math.max(30_000, Math.min(Number(req.timeoutMs) || 300_000, 600_000)));

      let model = String(req.model || DEFAULT_IMAGE_MODEL).trim();
      const online = await onlineModels(AbortSignal.timeout(8000));
      if (online && !online.some((n) => n.toLowerCase() === model.toLowerCase())) {
        // an explicitly named model that is offline is an error; the default silently moves on
        if (req.model && model !== DEFAULT_IMAGE_MODEL) {
          throw new Error(`AI Power Grid image model "${model}" is not online. Online now: ${online.join(", ") || "none"}.`);
        }
        if (!online.length) throw new Error("No image model is online on AI Power Grid right now.");
        model = online[0];
      } else if (online) {
        model = online.find((n) => n.toLowerCase() === model.toLowerCase());
      }
      const size = IMAGE_SIZES.includes(req.size) ? req.size : IMAGE_SIZES[0];
      const n = Math.max(1, Math.min(Number(req.count) || 1, 4));

      const r = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", ...clientHeader },
        body: JSON.stringify({ model, prompt: req.prompt, n, size }),
        signal,
      });
      if (!r.ok) throw await gridError(r);
      const data = (await r.json())?.data;
      const images = [];
      for (const [i, item] of (Array.isArray(data) ? data : []).entries()) {
        let buffer = null;
        if (typeof item?.b64_json === "string" && item.b64_json) {
          buffer = Buffer.from(item.b64_json, "base64");
        } else if (typeof item?.url === "string" && item.url.startsWith("https://")) {
          const d = await fetch(item.url, { signal });
          if (!d.ok) throw new Error(`AI Power Grid image download failed (HTTP ${d.status}).`);
          buffer = Buffer.from(await d.arrayBuffer());
        }
        if (!buffer || !buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
        const [mimeType, ext] = sniff(buffer);
        images.push({ buffer, mimeType, fileName: `aipg-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}.${ext}` });
      }
      if (!images.length) throw new Error("AI Power Grid returned no image data.");
      return { images, model };
    },
  };
}

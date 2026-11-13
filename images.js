// Image generation and editing on AI Power Grid for OpenClaw's image_generate tool.
//
// Only the image prompt (and, for an edit, the source image) goes to the grid,
// so this works next to any main model. Plain fetch on purpose: the
// OpenAI-compatible image builder of the plugin SDK is reserved for bundled plugins.
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { BASE_URL, CLIENT_HEADER, ENV_VAR, ID, USER_AGENT, apiKeyFor, gridError, missingKeyError, onlineModels } from "./grid.js";
import { fetchGridMedia } from "./safe.js";

export const IMAGE_SIZES = ["1024x1024", "1344x768", "768x1344", "1216x832", "832x1216"];
// The model this was tested with; the others are offered when they are online.
export const DEFAULT_IMAGE_MODEL = "z-image-turbo";
const KNOWN_IMAGE_MODELS = [DEFAULT_IMAGE_MODEL, "FLUX.2 Klein 4B FP8", "Krea 2 Turbo", "MOSS Image SFT BF16"];
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024; // the grid's limit for an inline source image

function sniff(buf) {
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ["image/webp", "webp"];
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return ["image/png", "png"];
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return ["image/jpeg", "jpg"];
  return ["application/octet-stream", "bin"];
}

export function buildImageProvider() {
  return {
    id: ID,
    label: "AI Power Grid",
    defaultModel: DEFAULT_IMAGE_MODEL,
    models: [...KNOWN_IMAGE_MODELS],
    isConfiguredAsync: async (ctx) => Boolean((process.env[ENV_VAR] || "").trim()) || (await isProviderApiKeyConfiguredAsync({ provider: ID, ...ctx })),
    capabilities: {
      generate: { maxCount: 4, supportsSize: true, supportsAspectRatio: false, supportsResolution: false },
      edit: { enabled: true, maxCount: 4, maxInputImages: 1, supportsSize: true, supportsAspectRatio: false, supportsResolution: false },
      geometry: { sizes: [...IMAGE_SIZES] },
    },
    async generateImage(req) {
      const sources = req.inputImages ?? [];
      if (sources.length > 1) throw new Error("AI Power Grid image editing takes one source image.");
      const apiKey = await apiKeyFor(req);
      if (!apiKey) throw missingKeyError();
      const signal = AbortSignal.timeout(Math.max(30_000, Math.min(Number(req.timeoutMs) || 300_000, 600_000)));

      let model = String(req.model || DEFAULT_IMAGE_MODEL).trim();
      const online = (await onlineModels("image"))?.map((m) => String(m.name));
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
      const body = { model, prompt: req.prompt, n: Math.max(1, Math.min(Number(req.count) || 1, 4)) };
      if (IMAGE_SIZES.includes(req.size)) body.size = req.size;
      else if (!sources.length) body.size = IMAGE_SIZES[0]; // an edit without a size keeps the source's shape
      if (sources.length) {
        const src = Buffer.from(sources[0].buffer);
        if (!src.length || src.length > MAX_SOURCE_BYTES) throw new Error("The source image for AI Power Grid must be between 1 byte and 12 MB.");
        body.image = src.toString("base64");
      }

      const r = await fetch(`${BASE_URL}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT, ...CLIENT_HEADER },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) throw await gridError(r, sources.length ? "image edit" : "image generation");
      const data = (await r.json())?.data;
      const images = [];
      // never more items than were asked for, whatever the reply holds
      for (const [i, item] of (Array.isArray(data) ? data : []).slice(0, body.n).entries()) {
        let buffer = null;
        if (typeof item?.b64_json === "string" && item.b64_json) {
          if (item.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) continue; // too large before decoding
          buffer = Buffer.from(item.b64_json, "base64");
        } else if (typeof item?.url === "string") {
          // only from the grid's own media hosts, without redirects, with a byte limit
          buffer = await fetchGridMedia(item.url, { maxBytes: MAX_IMAGE_BYTES, signal });
        }
        if (!buffer || !buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
        const [mimeType, ext] = sniff(buffer);
        if (ext === "bin") continue; // not a WebP, PNG or JPEG: do not hand it on
        images.push({ buffer, mimeType, fileName: `aipg-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}.${ext}` });
      }
      if (!images.length) throw new Error("AI Power Grid returned no image data.");
      return { images, model };
    },
  };
}

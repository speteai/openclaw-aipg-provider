// Video generation on AI Power Grid for OpenClaw's video_generate tool.
//
// Uses the grid's job API: submit, then ask every few seconds until the job is
// done. A plain request would be dropped by the grid's proxy after 120 seconds.
import { randomUUID } from "node:crypto";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { ENV_VAR, ID, apiKeyFor, gridJson, missingKeyError, onlineModels } from "./grid.js";

export const DEFAULT_VIDEO_MODEL = "LTX-2.5 Distilled BF16";
const MAX_SECONDS = 26; // the grid's limit (625 frames at 24 fps)
const DEFAULT_SECONDS = 4;
const FALLBACK_USD_PER_SECOND = 0.02;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

// The ceiling the grid may charge for this job: the list price plus a margin,
// because the grid rounds the length up to whole frames.
async function costCeilingMicro(model, seconds, signal) {
  let perSecond = FALLBACK_USD_PER_SECOND;
  try {
    const book = await gridJson("/pricing", { signal }, "pricing");
    const row = (book?.price_book?.models || []).find((m) => String(m.model).toLowerCase() === model.toLowerCase());
    const p = Number(row?.rates?.per_video_second_usd);
    if (p > 0) perSecond = p;
  } catch {
    // keep the fallback price
  }
  return Math.ceil(seconds * perSecond * 1.25 * 1e6) + 5000;
}

export function buildVideoProvider() {
  return {
    id: ID,
    label: "AI Power Grid",
    defaultModel: DEFAULT_VIDEO_MODEL,
    defaultTimeoutMs: 600_000,
    models: [DEFAULT_VIDEO_MODEL],
    isConfiguredAsync: async (ctx) => Boolean((process.env[ENV_VAR] || "").trim()) || (await isProviderApiKeyConfiguredAsync({ provider: ID, ...ctx })),
    capabilities: {
      generate: { maxVideos: 1, maxDurationSeconds: MAX_SECONDS },
      imageToVideo: { enabled: true, maxVideos: 1, maxInputImages: 1, maxDurationSeconds: MAX_SECONDS },
      videoToVideo: { enabled: false },
    },
    async generateVideo(req) {
      if ((req.inputVideos ?? []).length) throw new Error("AI Power Grid video-to-video is not supported by this plugin.");
      const images = req.inputImages ?? [];
      if (images.length > 1) throw new Error("AI Power Grid image-to-video takes one source image.");
      const key = await apiKeyFor(req);
      if (!key) throw missingKeyError();
      const deadline = Date.now() + Math.max(60_000, Math.min(Number(req.timeoutMs) || 600_000, 1_800_000));
      const signal = AbortSignal.timeout(Math.max(1000, deadline - Date.now()));

      let model = String(req.model || DEFAULT_VIDEO_MODEL).trim();
      const online = (await onlineModels("video"))?.map((m) => String(m.name));
      if (online) {
        const hit = online.find((n) => n.toLowerCase() === model.toLowerCase());
        if (hit) model = hit;
        else if (req.model && model !== DEFAULT_VIDEO_MODEL) throw new Error(`AI Power Grid video model "${model}" is not online. Online now: ${online.join(", ") || "none"}.`);
        else if (!online.length) throw new Error("No video model is online on AI Power Grid right now.");
        else model = online[0];
      }
      const seconds = Math.max(1, Math.min(Number(req.durationSeconds) || DEFAULT_SECONDS, MAX_SECONDS));
      const body = { prompt: req.prompt, model, seconds, max_cost_micro_usd: await costCeilingMicro(model, seconds, signal) };
      if (typeof req.size === "string" && /^\d{2,4}x\d{2,4}$/.test(req.size)) body.size = req.size;
      if (req.audio === false) body.audio = false;
      if (images.length) {
        const src = Buffer.from(images[0].buffer);
        if (!src.length || src.length > MAX_SOURCE_BYTES) throw new Error("The source image for AI Power Grid must be between 1 byte and 12 MB.");
        body.image = src.toString("base64");
      }

      // The key lets a lost reply be recovered without paying twice.
      let job = await gridJson("/videos/jobs", { key, method: "POST", body, signal, headers: { "Idempotency-Key": randomUUID().replace(/-/g, "") } }, "video generation");
      const jobId = job?.job_id;
      if (!jobId) throw new Error("AI Power Grid did not accept the video job.");
      while (job.state !== "completed" && job.state !== "closed_without_result") {
        if (Date.now() > deadline) throw new Error(`AI Power Grid video job ${jobId} was not finished in time; it may still complete and be charged.`);
        await new Promise((r) => setTimeout(r, 5000));
        job = await gridJson(`/videos/jobs/${jobId}`, { key, signal }, "video status");
      }
      const media = job.result?.media;
      if (job.state !== "completed" || !Array.isArray(media) || !media.length) {
        throw new Error(`AI Power Grid closed video job ${jobId} without a result; nothing should be charged for it.`);
      }
      const videos = media.filter((m) => typeof m?.url === "string" && m.url.startsWith("https://")).map((m, i) => ({
        url: m.url, mimeType: "video/mp4", fileName: `aipg-video-${i + 1}.mp4`,
      }));
      if (!videos.length) throw new Error("AI Power Grid returned no video.");
      return {
        videos,
        model: job.result?.model || model,
        metadata: { jobId, worker: job.result?.worker, seconds, chargedUsd: Number(job.actual_micro) / 1e6 || undefined },
      };
    },
  };
}

// Small shared pieces: where the grid is, which key to use, how to read its errors.
import { resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";

export const ID = "aipg";
export const VERSION = "0.6.2";
export const ENV_VAR = "AIPG_API_KEY";
// AIPG_BASE_URL is for tests against a stand-in server; leave it unset otherwise.
export const BASE_URL = (process.env.AIPG_BASE_URL || "https://api.aipowergrid.io/v1").replace(/\/+$/, "");
// Sent with every request so the grid's operators can tell how much traffic
// comes from OpenClaw. It names the client, nothing about the user.
export const CLIENT_HEADER = { "X-AIPG-Client": `openclaw-aipg-provider/${VERSION}` };
export const USER_AGENT = `openclaw-aipg-provider/${VERSION}`;

// The key from the environment, else from OpenClaw's auth store.
export async function apiKeyFor({ cfg, agentDir, authStore } = {}) {
  const env = (process.env[ENV_VAR] || "").trim();
  if (env) return env;
  try {
    return (await resolveProviderAuthProfileApiKey({ provider: ID, cfg, agentDir, store: authStore })) || "";
  } catch {
    return "";
  }
}

export function missingKeyError() {
  return new Error(`AI Power Grid API key missing: set ${ENV_VAR} or run "openclaw models auth paste-api-key --provider ${ID}".`);
}

export async function gridError(r, what) {
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
    : r.status === 402 ? " The grid account has no spendable credit for this."
    : r.status === 429 ? " The grid is rate-limiting this account; wait a minute."
    : "";
  return new Error(`AI Power Grid ${what} failed (HTTP ${r.status})${detail && detail !== "null" ? ": " + detail : ""}.${hint}`);
}

export async function gridJson(path, { key, method = "GET", body, signal, headers = {} } = {}, what = "request") {
  const r = await fetch(BASE_URL + path, {
    method,
    headers: {
      Accept: "application/json", "User-Agent": USER_AGENT, ...CLIENT_HEADER,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw await gridError(r, what);
  return r.json();
}

// Models of one type that have a worker right now; null when the grid cannot be asked.
export async function onlineModels(type, signal = AbortSignal.timeout(8000)) {
  try {
    const all = await gridJson("/status/models", { signal }, "status");
    return (Array.isArray(all) ? all : []).filter((m) => m && m.type === type && (m.count || 0) > 0);
  } catch {
    return null;
  }
}

export const usd = (n) => "$" + (Math.abs(n) > 0 && Math.abs(n) < 0.01 ? Number(n).toFixed(6) : Number(n).toFixed(4));

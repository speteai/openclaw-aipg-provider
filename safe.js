// Checks on what the grid sends back before the plugin acts on it: where a
// media link may point, and what a wallet may sign.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// The grid stores generated media on its own hosts. A link anywhere else is refused.
const MEDIA_HOST_SUFFIXES = [".aipg.art", ".aipowergrid.io"];

function isPublicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return false; // link-local
    if (s.startsWith("fc") || s.startsWith("fd")) return false; // unique local
    if (s.startsWith("ff")) return false; // multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

// The parsed URL when it is an https link to one of the grid's media hosts, else null.
export function gridMediaUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  if (isIP(host)) return null;
  if (!MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) return null;
  return u;
}

// Download from a grid media host: no redirects, only public addresses, never
// more than `maxBytes`. Returns a Buffer.
export async function fetchGridMedia(value, { maxBytes, signal }) {
  const u = gridMediaUrl(value);
  if (!u) throw new Error("AI Power Grid returned a media link that does not point to its own storage; it was not opened.");
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new Error("The grid's media host does not resolve to a public address; the link was not opened.");
  }
  const r = await fetch(u, { redirect: "error", signal });
  if (!r.ok) throw new Error(`AI Power Grid media download failed (HTTP ${r.status}).`);
  const declared = Number(r.headers.get("content-length"));
  if (declared > maxBytes) throw new Error("The file on the grid's media host is larger than allowed.");
  const chunks = [];
  let size = 0;
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("The file on the grid's media host is larger than allowed.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const SIGN_IN_DOMAIN = "console.aipowergrid.io";
const SIGN_IN_URI = "https://console.aipowergrid.io";
const SIGN_IN_STATEMENT = "Sign in to AI Power Grid.";
const BASE_CHAIN_ID = 8453;
export const SIGN_IN = { domain: SIGN_IN_DOMAIN, uri: SIGN_IN_URI, chainId: BASE_CHAIN_ID };

// A wallet must only sign the one message this sign-in consists of: an
// EIP-4361 text for the grid's Console, this wallet, Base, a nonce and a short
// validity, and nothing else. Anything that differs is refused, so a tampered
// reply cannot get a signature for something other than this sign-in.
export function assertSignInMessage(message, { address, nonce, now = Date.now() }) {
  const refuse = (why) => {
    throw new Error(`AI Power Grid returned a sign-in message that ${why}; nothing was signed.`);
  };
  if (typeof message !== "string" || message.length > 1000) refuse("is not a sign-in text");
  const lines = message.split("\n");
  if (lines.length !== 11) refuse("has an unexpected shape");
  if (lines[0] !== `${SIGN_IN_DOMAIN} wants you to sign in with your Ethereum account:`) refuse("is not for the grid's Console");
  if (lines[1] !== address) refuse("names another wallet");
  if (lines[2] !== "" || lines[4] !== "") refuse("has an unexpected shape");
  if (lines[3] !== SIGN_IN_STATEMENT) refuse("asks for something other than a sign-in");
  if (lines[5] !== `URI: ${SIGN_IN_URI}`) refuse("is for another address");
  if (lines[6] !== "Version: 1") refuse("has an unknown version");
  if (lines[7] !== `Chain ID: ${BASE_CHAIN_ID}`) refuse("is not for Base");
  const n = /^Nonce: ([0-9a-fA-F]{8,64})$/.exec(lines[8]);
  if (!n) refuse("has no usable nonce");
  // The API does not accept a nonce from the client, so the check is that the
  // message carries the nonce the same reply announced.
  if (typeof nonce !== "string" || n[1] !== nonce) refuse("carries a different nonce than the reply it came in");
  const stamp = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)";
  const issued = new RegExp(`^Issued At: ${stamp}$`).exec(lines[9]);
  const expires = new RegExp(`^Expiration Time: ${stamp}$`).exec(lines[10]);
  if (!issued || !expires) refuse("has no usable validity");
  const from = Date.parse(issued[1]), until = Date.parse(expires[1]);
  if (!Number.isFinite(from) || !Number.isFinite(until)) refuse("has no usable validity");
  if (Math.abs(from - now) > 5 * 60_000) refuse("was not issued just now");
  if (until <= now || until - from > 15 * 60_000) refuse("is valid for longer than a sign-in needs");
}

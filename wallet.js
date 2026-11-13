// Sign in to AI Power Grid with a Base wallet instead of a browser.
//
// The grid's wallet sign-in is plain HTTP: ask for
// a message, sign it with the wallet key, send the signature back. The grid
// then creates the account if the wallet is new and lets the fresh session
// create an API key. Only that API key is stored by OpenClaw; the wallet key
// is used in memory for the one signature and is never written anywhere.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { SIGN_IN, assertSignInMessage } from "./safe.js";

const hex = (b) => Buffer.from(b).toString("hex");

export function parsePrivateKey(input) {
  const s = String(input || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("That is not a wallet private key: it is 64 hexadecimal characters, with or without 0x.");
  return Buffer.from(s, "hex");
}

// EIP-55 checksummed address of a private key.
export function addressOf(priv) {
  const pub = secp256k1.getPublicKey(priv, false); // 0x04 || X || Y
  const a = hex(keccak_256(pub.slice(1)).slice(-20));
  const h = hex(keccak_256(new TextEncoder().encode(a)));
  return "0x" + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

// EIP-191 personal_sign.
export function personalSign(priv, message) {
  const msg = new TextEncoder().encode(message);
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
  const sig = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" }); // recovery || r || s
  return "0x" + hex(sig.slice(1)) + (27 + sig[0]).toString(16);
}

async function call(baseUrl, path, { method = "GET", body, token, headers = {}, signal } = {}) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // no JSON body
  }
  if (!r.ok) {
    const d = json && (json.detail ?? json.error);
    const detail = typeof d === "string" ? d : d && d.message ? d.message : JSON.stringify(d ?? json);
    throw new Error(`AI Power Grid ${path} failed (HTTP ${r.status})${detail && detail !== "null" ? ": " + detail : ""}`);
  }
  return json;
}

// Returns { apiKey, address, created, funding } where `funding` describes how
// this wallet can add credit (USDC on Base), or null when it cannot be read.
export async function walletSignIn({ privateKey, baseUrl, clientHeader = {}, label = "openclaw", signal }) {
  const priv = parsePrivateKey(privateKey);
  const address = addressOf(priv);
  const headers = { "User-Agent": "openclaw-aipg-provider", ...clientHeader };
  // The grid lists the domains it accepts; `localhost` is the one for programs (see safe.js).
  const challenge = await call(baseUrl, "/accounts/wallet/challenge", {
    method: "POST", headers, signal,
    body: { address, domain: SIGN_IN.domain, uri: SIGN_IN.uri, chain_id: SIGN_IN.chainId },
  });
  // Sign only the exact sign-in text; anything else in the reply is refused.
  assertSignInMessage(challenge?.message, { address, nonce: challenge?.nonce });
  const signature = personalSign(priv, challenge.message);
  priv.fill(0);
  const session = await call(baseUrl, "/accounts/wallet/verify", {
    method: "POST", headers, signal, body: { message: challenge.message, signature, address },
  });
  if (!session?.access_token) throw new Error("AI Power Grid did not return a session for this wallet.");
  const key = await call(baseUrl, "/account/keys", { method: "POST", headers, signal, token: session.access_token, body: { label } });
  if (typeof key?.api_key !== "string" || !key.api_key) throw new Error("AI Power Grid did not return an API key.");

  let funding = null;
  try {
    const [credits, cfg] = await Promise.all([
      call(baseUrl, "/account/credits", { headers, signal, token: key.api_key }),
      call(baseUrl, "/account/deposits/config", { headers, signal, token: key.api_key }),
    ]);
    const usdc = (cfg?.assets || []).find((a) => a.asset === "USDC" && a.enabled);
    funding = {
      spendableUsd: Number(credits?.total_spendable_usd) || 0,
      freeDailyUsd: Number(credits?.free?.daily_cap_usd) || 0,
      treasury: usdc?.treasury || null,
      minimumUsd: usdc ? Number(usdc.minimum_credit_micro) / 1e6 : null,
    };
  } catch {
    // the key works without this; the note is then shorter
  }
  return { apiKey: key.api_key, address, created: Boolean(session.created), funding };
}

export function fundingNotes({ address, created, funding }) {
  const notes = [`${created ? "Created a new" : "Signed in to the existing"} AI Power Grid account of wallet ${address}; the grid issued a new API key.`];
  if (!funding) return notes;
  if (funding.spendableUsd > 0) {
    notes.push(`Spendable credit: $${funding.spendableUsd.toFixed(4)}${funding.freeDailyUsd > 0 ? ` (daily free allowance $${funding.freeDailyUsd.toFixed(2)})` : ""}.`);
  } else {
    notes.push("The account has no credit yet, so requests will be refused with HTTP 402.");
  }
  if (funding.treasury && funding.spendableUsd <= 0) {
    notes.push(
      `To add credit: send USDC on Base (chain 8453) from this same wallet to ${funding.treasury}` +
        `${funding.minimumUsd ? ` (at least $${funding.minimumUsd})` : ""}, then report the transaction with ` +
        `POST https://api.aipowergrid.io/v1/account/deposits/claim {"tx_hash":"0x..."} using the API key. ` +
        "Credit cannot be withdrawn or moved. A wallet that holds 10,000 AIPG or more gets a daily free allowance instead.",
    );
  }
  return notes;
}

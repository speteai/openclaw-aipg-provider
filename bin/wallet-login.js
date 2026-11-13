#!/usr/bin/env node
// Wallet sign-in without a terminal prompt, for automation and agents:
//
//   AIPG_WALLET_PRIVATE_KEY=0x... node wallet-login.js | openclaw models auth paste-api-key --provider aipg
//
// Prints the new API key on stdout and nothing else there; everything a
// person should read goes to stderr. The wallet key is read from the
// environment, used for one signature and not written anywhere.
import { fundingNotes, walletSignIn } from "../wallet.js";

const BASE_URL = (process.env.AIPG_BASE_URL || "https://api.aipowergrid.io/v1").replace(/\/+$/, "");
const privateKey = (process.env.AIPG_WALLET_PRIVATE_KEY || "").trim();
if (!privateKey) {
  console.error("Set AIPG_WALLET_PRIVATE_KEY to the private key of a Base wallet (64 hex characters).");
  process.exit(2);
}
try {
  const result = await walletSignIn({ privateKey, baseUrl: BASE_URL, clientHeader: { "X-AIPG-Client": "openclaw-aipg-provider/wallet-login" }, signal: AbortSignal.timeout(60_000) });
  for (const line of fundingNotes(result)) console.error(line);
  process.stdout.write(result.apiKey + "\n");
} catch (err) {
  console.error(String(err?.message || err));
  process.exit(1);
}

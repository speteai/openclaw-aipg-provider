#!/usr/bin/env node
// Shows what a wallet's AIPG brings on AI Power Grid: the balance on Base, the
// holder tier it reaches and what is missing for the next one.
//
//   AIPG_API_KEY=grid_... node wallet-holder.js --address 0x...
//   AIPG_API_KEY=grid_... AIPG_WALLET_PRIVATE_KEY=0x... node wallet-holder.js
//
// Read-only: one balance query on Base and the account's credit summary. It
// signs nothing and sends nothing. The wallet key is only used to work out the
// address when --address is not given.
import { addressOf, parsePrivateKey } from "../wallet.js";
import { rpcClient } from "../tx.js";
import { aipgBalance, holderReport } from "../holder.js";

const BASE_URL = (process.env.AIPG_BASE_URL || "https://api.aipowergrid.io/v1").replace(/\/+$/, "");
const RPC_URL = process.env.AIPG_BASE_RPC || "https://mainnet.base.org";

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const args = process.argv.slice(2);
const at = args.indexOf("--address");
let address = at >= 0 ? String(args[at + 1] || "") : "";
if (address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail("--address must be a wallet address (0x and 40 hex characters).", 2);
} else {
  try {
    address = addressOf(parsePrivateKey(process.env.AIPG_WALLET_PRIVATE_KEY));
  } catch {
    fail("Give the wallet with --address 0x..., or set AIPG_WALLET_PRIVATE_KEY.", 2);
  }
}
const apiKey = (process.env.AIPG_API_KEY || "").trim();
if (!apiKey) fail("Set AIPG_API_KEY to the API key of the wallet's account (wallet-login.js creates one).", 2);

try {
  const [balance, credits] = await Promise.all([
    aipgBalance(rpcClient(RPC_URL), address),
    fetch(BASE_URL + "/account/credits", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-AIPG-Client": "openclaw-aipg-provider/wallet-holder" },
      signal: AbortSignal.timeout(30_000),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`AI Power Grid credit summary failed (HTTP ${r.status}).`);
      return r.json();
    }),
  ]);
  for (const line of holderReport({ address, balance, free: credits?.free })) console.log(line);
} catch (err) {
  fail(String(err?.message || err));
}

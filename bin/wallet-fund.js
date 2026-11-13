#!/usr/bin/env node
// Add credit to an AI Power Grid account from the wallet it belongs to:
// send USDC on Base to the grid's treasury, then report the transaction.
//
//   AIPG_WALLET_PRIVATE_KEY=0x... AIPG_API_KEY=grid_... node wallet-fund.js --amount 0.5          # shows the plan, sends nothing
//   AIPG_WALLET_PRIVATE_KEY=0x... AIPG_API_KEY=grid_... node wallet-fund.js --amount 0.5 --yes    # sends
//
// This moves money and grid credit cannot be withdrawn, so it does nothing
// without --yes, never sends more than AIPG_FUND_MAX_USDC (default 5), and
// stops unless the grid confirms that the API key's account belongs to this wallet.
import { addressOf, parsePrivateKey } from "../wallet.js";
import { erc20TransferData, rpcClient, signEip1559 } from "../tx.js";

const BASE_URL = (process.env.AIPG_BASE_URL || "https://api.aipowergrid.io/v1").replace(/\/+$/, "");
const RPC_URL = process.env.AIPG_BASE_RPC || "https://mainnet.base.org";
const USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // Circle's USDC on Base; never taken from a server
const CHAIN_ID = 8453;

function say(...a) {
  console.error(...a);
}
function fail(msg, code = 1) {
  say(msg);
  process.exit(code);
}
function usdcText(n) {
  const s = (Number(n) / 1e6).toFixed(6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

const args = process.argv.slice(2);
const amountAt = args.indexOf("--amount");
const amountText = amountAt >= 0 ? args[amountAt + 1] : undefined;
const confirmed = args.includes("--yes");
if (!amountText || !/^\d+(\.\d{1,6})?$/.test(amountText)) fail("Usage: wallet-fund.js --amount <USDC, up to 6 decimals> [--yes]", 2);
const [whole, frac = ""] = amountText.split(".");
const amount = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
const capText = process.env.AIPG_FUND_MAX_USDC || "5";
if (!/^\d+(\.\d+)?$/.test(capText)) fail("AIPG_FUND_MAX_USDC must be a number.", 2);
const cap = BigInt(Math.round(Number(capText) * 1e6));
if (amount <= 0n) fail("The amount must be above zero.", 2);
if (amount > cap) fail(`Refused: ${amountText} USDC is above the limit of ${capText} USDC (AIPG_FUND_MAX_USDC).`, 2);

const apiKey = (process.env.AIPG_API_KEY || "").trim();
if (!apiKey) fail("Set AIPG_API_KEY to the API key of the wallet's account (wallet-login.js creates one).", 2);
let priv;
try {
  priv = parsePrivateKey(process.env.AIPG_WALLET_PRIVATE_KEY);
} catch (e) {
  fail(e.message, 2);
}
const address = addressOf(priv);

async function api(path, init = {}) {
  const r = await fetch(BASE_URL + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-aipg-provider",
      "X-AIPG-Client": "openclaw-aipg-provider/wallet-fund",
    },
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    // no JSON body
  }
  return { status: r.status, body };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const cfg = await api("/account/deposits/config");
  if (cfg.status !== 200) fail(`The grid did not return the deposit settings (HTTP ${cfg.status}). Is the API key right?`);
  const linked = [cfg.body.linked_wallet, ...(cfg.body.linked_wallets || [])].filter(Boolean).map((a) => String(a).toLowerCase());
  if (!linked.includes(address.toLowerCase())) {
    fail(`Refused: this API key's account does not belong to wallet ${address}. A deposit is only credited when it comes from the account's own wallet.`);
  }
  if (Number(cfg.body.chain?.id) !== CHAIN_ID) fail("Refused: the grid does not report Base as its deposit chain.");
  const usdc = (cfg.body.assets || []).find((a) => a.asset === "USDC");
  if (!usdc || !usdc.enabled || usdc.status !== "available") fail("USDC deposits are not available on the grid right now.");
  if (String(usdc.token_address).toLowerCase() !== USDC_ON_BASE) fail("Refused: the grid reports a token address that is not USDC on Base.");
  const treasury = String(usdc.treasury || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) fail("Refused: the grid reported no usable treasury address.");
  if (amount < BigInt(usdc.minimum_credit_micro || 0)) fail(`The grid's minimum is ${usdcText(usdc.minimum_credit_micro)} USDC.`);
  if (amount > BigInt(usdc.maximum_credit_micro || 0)) fail(`The grid's maximum per deposit is ${usdcText(usdc.maximum_credit_micro)} USDC.`);

  const rpc = rpcClient(RPC_URL);
  if (Number(await rpc("eth_chainId")) !== CHAIN_ID) fail("Refused: the RPC endpoint is not Base mainnet.");
  const data = erc20TransferData(treasury, amount);
  const balanceOf = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const [usdcBalance, ethBalance, nonce, tip, block] = await Promise.all([
    rpc("eth_call", [{ to: USDC_ON_BASE, data: balanceOf }, "latest"]).then(BigInt),
    rpc("eth_getBalance", [address, "latest"]).then(BigInt),
    rpc("eth_getTransactionCount", [address, "pending"]).then(Number),
    rpc("eth_maxPriorityFeePerGas").then(BigInt).catch(() => 1_000_000n),
    rpc("eth_getBlockByNumber", ["latest", false]),
  ]);
  if (usdcBalance < amount) fail(`The wallet holds ${usdcText(usdcBalance)} USDC on Base, less than the ${amountText} to send.`);
  const estimate = await rpc("eth_estimateGas", [{ from: address, to: USDC_ON_BASE, data: "0x" + data.toString("hex") }]);
  const gas = (BigInt(estimate) * 13n) / 10n;
  const maxFee = BigInt(block.baseFeePerGas || "0x0") * 2n + tip;
  if (ethBalance < gas * maxFee) fail(`The wallet holds too little ETH on Base for the fee (needs up to ${Number(gas * maxFee) / 1e18} ETH).`);

  say(`Wallet:    ${address}  (${usdcText(usdcBalance)} USDC, ${(Number(ethBalance) / 1e18).toFixed(6)} ETH on Base)`);
  say(`Send:      ${amountText} USDC to the grid treasury ${treasury}`);
  say(`Fee:       at most ${(Number(gas * maxFee) / 1e18).toFixed(9)} ETH`);
  say("Result:    grid credit of the same amount in USD. It cannot be withdrawn or moved to another account.");
  if (!confirmed) fail("Nothing was sent. Run again with --yes to send.", 3);

  const raw = signEip1559(priv, { chainId: CHAIN_ID, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gas, to: USDC_ON_BASE, data });
  priv.fill(0);
  const hash = await rpc("eth_sendRawTransaction", [raw]);
  say(`Sent:      ${hash}`);
  const later = `Claim it later: POST ${BASE_URL}/account/deposits/claim {"tx_hash":"${hash}"}`;
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    await pause(2000);
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
  }
  if (!receipt) fail(`The transaction is not confirmed yet. ${later}`);
  if (Number(receipt.status) !== 1) fail("The transaction failed on chain; nothing was deposited.");
  let claim = null;
  for (let i = 0; i < 12; i++) {
    claim = await api("/account/deposits/claim", { method: "POST", body: JSON.stringify({ tx_hash: hash }) });
    if (claim.status === 200) break;
    await pause(5000); // the grid waits for a few confirmations
  }
  if (!claim || claim.status !== 200) fail(`The grid has not credited it yet (HTTP ${claim?.status}). ${later}`);
  say(`Credited:  $${Number(claim.body.amount_usd).toFixed(4)}; balance now $${Number(claim.body.balance_usd).toFixed(4)}`);
  process.stdout.write(JSON.stringify({ tx_hash: hash, credited_usd: claim.body.amount_usd, balance_usd: claim.body.balance_usd }) + "\n");
} catch (err) {
  fail(String(err?.message || err));
}

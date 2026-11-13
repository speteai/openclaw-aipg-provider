// The grid gives an account extra free credit each day when its sign-in wallet
// holds AIPG on Base. This file only reads and reckons; it moves nothing.

// The AIPG token on Base (18 decimals). Fixed here, never taken from a server.
export const AIPG_ON_BASE = "0xa1c0decafe3e9bf06a5f29b7015cd373a9854608";
const DECIMALS = 18n;

// balanceOf(address) call data.
export function balanceOfData(address) {
  const a = String(address).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error("Not a wallet address.");
  return "0x70a08231" + a.padStart(64, "0");
}

// Whole AIPG held by `address`, read from a Base JSON-RPC endpoint (`rpc(method, params)`).
export async function aipgBalance(rpc, address) {
  const hex = await rpc("eth_call", [{ to: AIPG_ON_BASE, data: balanceOfData(address) }, "latest"]);
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error("Base RPC returned no balance.");
  return Number(BigInt(hex === "0x" ? "0x0" : hex) / 10n ** DECIMALS);
}

// The tiers from the grid's credit summary, smallest first: [{ min, usd }].
export function holderTiers(free) {
  return (Array.isArray(free?.holder_tiers) ? free.holder_tiers : [])
    .map((t) => ({ min: Number(t?.min_aipg), usd: Number(t?.daily_usd) }))
    .filter((t) => t.min > 0 && t.usd > 0)
    .sort((a, b) => a.min - b.min);
}

// Where a balance stands: the tier it reaches (or null) and the next one up (or null).
export function holderStanding(tiers, balance) {
  let reached = null;
  let next = null;
  for (const t of tiers) {
    if (balance >= t.min) reached = t;
    else if (!next) next = { ...t, missing: t.min - balance };
  }
  return { reached, next };
}

const usd = (n) => "$" + Number(n).toFixed(2);
const aipg = (n) => Number(n).toLocaleString("en-US") + " AIPG";

// One line per tier, for a person or an agent to read.
export function tierLines(tiers) {
  return tiers.map((t) => `${aipg(t.min)} in the sign-in wallet: ${usd(t.usd)} more free credit a day`);
}

// The full report as lines of text.
export function holderReport({ address, balance, free }) {
  const tiers = holderTiers(free);
  const lines = [`Wallet ${address} holds ${aipg(balance)} on Base.`];
  if (!tiers.length) {
    lines.push("The grid reports no holder tiers for this account right now.");
    return lines;
  }
  const { reached, next } = holderStanding(tiers, balance);
  const bonus = Number(free?.holder_bonus_usd) || 0;
  if (bonus > 0) lines.push(`Today the account received ${usd(bonus)} of free credit for holding AIPG.`);
  if (reached) {
    lines.push(`That reaches the ${aipg(reached.min)} tier: ${usd(reached.usd)} of free credit a day.`);
    if (!(bonus > 0)) {
      lines.push(
        "The account received no holder credit today. That is expected if this wallet is not the account's sign-in wallet " +
          "or if the tokens arrived today: the grid counts the balance at the last Base block before midnight UTC, so the " +
          "first allowance comes the day after. The network also grants only a limited total per day.",
      );
    }
  } else {
    lines.push("That is below the first tier, so there is no holder credit.");
  }
  if (next) lines.push(`Next tier: ${aipg(next.min)} for ${usd(next.usd)} a day, ${aipg(next.missing)} more than now.`);
  lines.push("Tiers:", ...tierLines(tiers).map((l) => "  " + l));
  lines.push(
    "The tokens stay in the wallet; the grid only reads the balance. Each wallet counts on its own. " +
      "The credit can only be spent on the grid.",
  );
  return lines;
}

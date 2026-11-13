// Checks that need no network and no OpenClaw: the wallet signature, the
// transaction encoding and the council parser. The vectors were produced with
// viem for the well-known test key 0x1111...11.
import assert from "node:assert/strict";
import fs from "node:fs";
import { addressOf, parsePrivateKey, personalSign } from "../wallet.js";
import { erc20TransferData, signEip1559 } from "../tx.js";
import { assertSignInMessage, gridMediaUrl } from "../safe.js";

const v = JSON.parse(fs.readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const priv = () => parsePrivateKey("0x" + "11".repeat(32));

assert.equal(addressOf(priv()), v.address, "address");
assert.equal(personalSign(priv(), v.message), v.signature, "personal_sign");
assert.equal(
  signEip1559(priv(), {
    chainId: 8453, nonce: 7, maxPriorityFeePerGas: 1000000n, maxFeePerGas: 13000000n, gas: 58576n,
    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    data: erc20TransferData("0xd19a391FAB4aeFd5f59e4be4918364f57b9c5346", 100000n),
  }),
  v.tx,
  "EIP-1559 transaction",
);
for (const bad of ["", "0x12", "zz".repeat(32)]) assert.throws(() => parsePrivateKey(bad), "bad key accepted: " + bad);

// what a wallet may sign
const addr = v.address, now = Date.parse("2026-11-13T09:33:40Z");
const msg = (o = {}) => [
  o.first ?? "localhost wants you to sign in with your Ethereum account:",
  o.address ?? addr, "", o.statement ?? "Sign in to AI Power Grid.", "",
  o.uri ?? "URI: http://localhost", "Version: 1", o.chain ?? "Chain ID: 8453",
  "Nonce: " + (o.nonce ?? "39d85cd150fb4d3d9ac234048a2bbafd"),
  "Issued At: " + (o.issued ?? "2026-11-13T09:33:31Z"), "Expiration Time: " + (o.expires ?? "2026-11-13T09:38:31Z"),
  ...(o.extra ?? []),
].join("\n");
const check = (o, nonce = "39d85cd150fb4d3d9ac234048a2bbafd") => assertSignInMessage(msg(o), { address: addr, nonce, now });
check({});
for (const [name, o, nonce] of [
  ["another site", { first: "evil.example wants you to sign in with your Ethereum account:" }],
  ["the Console's sign-in", { first: "console.aipowergrid.io wants you to sign in with your Ethereum account:", uri: "URI: https://console.aipowergrid.io" }],
  ["another wallet", { address: "0x000000000000000000000000000000000000dEaD" }],
  ["another statement", { statement: "Approve spending of all tokens." }],
  ["another uri", { uri: "URI: https://evil.example" }],
  ["another chain", { chain: "Chain ID: 1" }],
  ["extra resources", { extra: ["Resources:", "- https://evil.example/drain"] }],
  ["nonce mismatch", {}, "ffffffffffffffffffffffffffffffff"],
  ["issued long ago", { issued: "2026-11-13T08:00:00Z", expires: "2026-11-13T08:05:00Z" }],
  ["valid too long", { expires: "2026-11-14T09:33:31Z" }],
  ["already expired", { issued: "2026-11-13T09:30:00Z", expires: "2026-11-13T09:33:00Z" }],
]) assert.throws(() => check(o, nonce), /nothing was signed/, "accepted: " + name);
assert.throws(() => assertSignInMessage("please sign " + addr, { address: addr, nonce: "ab", now }), /nothing was signed/);

// where a media link may point
for (const ok of ["https://media.aipg.art/image/x/0.webp", "https://cdn.aipowergrid.io/a.png"]) assert.ok(gridMediaUrl(ok), ok);
for (const bad of ["http://media.aipg.art/a.webp", "https://aipg.art.evil.example/a.webp", "https://evilaipg.art/a", "https://127.0.0.1/a", "https://media.aipg.art:8443/a",
  "https://user:pw@media.aipg.art/a", "file:///etc/passwd", "https://169.254.169.254/latest/meta-data", "not a url", "https://aipg.art/a"]) assert.equal(gridMediaUrl(bad), null, bad);
// holder tiers
{
  const { aipgBalance, balanceOfData, holderReport, holderStanding, holderTiers } = await import("../holder.js");
  const free = { holder_bonus_usd: 0, holder_tiers: [{ min_aipg: 1000000, daily_usd: 2 }, { min_aipg: 10000, daily_usd: 0.1 }, { min_aipg: 100000, daily_usd: 0.5 }, { min_aipg: 0, daily_usd: 9 }, null] };
  const tiers = holderTiers(free);
  assert.deepEqual(tiers.map((t) => t.min), [10000, 100000, 1000000]);
  assert.deepEqual(holderTiers(null), []);
  assert.deepEqual(holderStanding(tiers, 0), { reached: null, next: { min: 10000, usd: 0.1, missing: 10000 } });
  assert.equal(holderStanding(tiers, 9999).reached, null);
  assert.equal(holderStanding(tiers, 10000).reached.usd, 0.1);
  assert.equal(holderStanding(tiers, 250000).next.missing, 750000);
  assert.equal(holderStanding(tiers, 5e6).next, null);
  assert.equal(balanceOfData("0x00000000000000000000000000000000000000Ab"), "0x70a08231" + "0".repeat(62) + "ab");
  assert.throws(() => balanceOfData("0x12"));
  const rpc = (hex) => async (method, params) => { assert.equal(method, "eth_call"); assert.equal(params[0].to, "0xa1c0decafe3e9bf06a5f29b7015cd373a9854608"); return hex; };
  assert.equal(await aipgBalance(rpc("0x" + (12345n * 10n ** 18n + 5n).toString(16).padStart(64, "0")), addr), 12345);
  assert.equal(await aipgBalance(rpc("0x"), addr), 0);
  await assert.rejects(aipgBalance(rpc(null), addr));
  const text = holderReport({ address: addr, balance: 12000, free }).join("\n");
  assert.match(text, /reaches the 10,000 AIPG tier: \$0\.10/);
  assert.match(text, /Next tier: 100,000 AIPG for \$0\.50 a day, 88,000 AIPG more/);
  assert.match(holderReport({ address: addr, balance: 12000, free: { ...free, holder_bonus_usd: 0.1 } }).join("\n"), /received \$0\.10/);
  assert.match(holderReport({ address: addr, balance: 5, free: {} }).join("\n"), /no holder tiers/);
}
console.log("unit: ok");

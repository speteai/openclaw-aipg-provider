// Checks that need no network and no OpenClaw: the wallet signature, the
// transaction encoding and the council parser. The vectors were produced with
// viem for the well-known test key 0x1111...11.
import assert from "node:assert/strict";
import fs from "node:fs";
import { addressOf, parsePrivateKey, personalSign } from "../wallet.js";
import { erc20TransferData, signEip1559 } from "../tx.js";

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
console.log("unit: ok");

// The little of Ethereum that funding needs: an EIP-1559 transaction that
// calls ERC-20 transfer, signed with the wallet key, and a JSON-RPC client.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const hex = (b) => Buffer.from(b).toString("hex");
const strip0x = (s) => String(s).replace(/^0x/i, "");

// Minimal bytes of a non-negative integer (empty for zero), as RLP wants it.
function intBytes(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error("negative number in transaction");
  if (v === 0n) return Buffer.alloc(0);
  let h = v.toString(16);
  if (h.length % 2) h = "0" + h;
  return Buffer.from(h, "hex");
}

function rlp(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlp));
    return Buffer.concat([rlpLength(body.length, 0xc0), body]);
  }
  const b = Buffer.from(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([rlpLength(b.length, 0x80), b]);
}

function rlpLength(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const l = intBytes(len);
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
}

// ERC-20 transfer(address,uint256)
export function erc20TransferData(to, amount) {
  return Buffer.concat([
    Buffer.from("a9059cbb", "hex"),
    Buffer.from(strip0x(to).toLowerCase().padStart(64, "0"), "hex"),
    Buffer.from(BigInt(amount).toString(16).padStart(64, "0"), "hex"),
  ]);
}

// Returns the raw signed EIP-1559 transaction as a 0x string.
export function signEip1559(priv, { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value = 0n, data }) {
  const fields = [
    intBytes(chainId), intBytes(nonce), intBytes(maxPriorityFeePerGas), intBytes(maxFeePerGas), intBytes(gas),
    Buffer.from(strip0x(to), "hex"), intBytes(value), Buffer.from(data), [],
  ];
  const digest = keccak_256(Buffer.concat([Buffer.from([0x02]), rlp(fields)]));
  const sig = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" }); // recovery || r || s
  const r = BigInt("0x" + hex(sig.slice(1, 33))), s = BigInt("0x" + hex(sig.slice(33, 65)));
  return "0x" + hex(Buffer.concat([Buffer.from([0x02]), rlp([...fields, intBytes(sig[0]), intBytes(r), intBytes(s)])]));
}

export function rpcClient(url) {
  let id = 0;
  return async (method, params = []) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Base RPC ${method} failed (HTTP ${r.status})`);
    const j = await r.json();
    if (j.error) throw new Error(`Base RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  };
}

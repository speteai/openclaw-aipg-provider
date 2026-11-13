// Installs the packed plugin into a fresh OpenClaw home and checks that it
// loads with everything it registers. Needs `openclaw` on the PATH. No grid
// account is used: the key below is a placeholder and no paid call is made.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "aipg-oc-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCLAW_HOME: home, AIPG_API_KEY: "grid_placeholder_for_install_test_0000" };
const win = process.platform === "win32";
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { env, cwd: root, encoding: "utf8", shell: win, timeout: 600_000, ...opts });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const jsonOf = (text) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

const packed = execFileSync(win ? "npm.cmd" : "npm", ["pack", "--pack-destination", home], { cwd: root, encoding: "utf8", shell: win }).trim().split(/\r?\n/).pop();
const tgz = path.join(home, packed);
assert.ok(fs.existsSync(tgz), "npm pack produced " + tgz);

let r = run("openclaw", ["plugins", "install", "npm-pack:" + tgz, "--force", "--accept-capabilities"]);
assert.equal(r.code, 0, "plugins install failed:\n" + r.out.slice(-2000));

r = run("openclaw", ["plugins", "inspect", "aipg", "--runtime", "--json"]);
assert.equal(r.code, 0, "plugins inspect failed:\n" + r.out.slice(-2000));
const info = jsonOf(r.out);
assert.equal(info.plugin.status, "loaded", "plugin status: " + info.plugin.status + " " + info.plugin.error);
const kinds = (info.capabilities || []).map((c) => c.kind).sort();
for (const k of ["image-generation", "text-inference", "video-generation"]) assert.ok(kinds.includes(k), "capability missing: " + k);
const tools = (info.tools || []).flatMap((t) => t.names);
for (const t of ["aipg_balance", "aipg_council"]) assert.ok(tools.includes(t), "tool missing: " + t);

// the helper programs refuse to run without what they need
const dir = info.plugin.rootDir;
r = run(process.execPath, [path.join(dir, "bin", "wallet-login.js")], { shell: false, env: { ...env, AIPG_WALLET_PRIVATE_KEY: "" } });
assert.equal(r.code, 2, "wallet-login without a key: " + r.out);
r = run(process.execPath, [path.join(dir, "bin", "wallet-fund.js")], { shell: false });
assert.equal(r.code, 2, "wallet-fund without an amount: " + r.out);

// the skill ships with the plugin
r = run("openclaw", ["skills", "list"]);
assert.ok(/ai-power-grid/.test(r.out), "skill not listed:\n" + r.out.slice(-1500));

console.log(`install: ok on ${process.platform} (${os.release()}), node ${process.version}, plugin ${info.plugin.version}`);

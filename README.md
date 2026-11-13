# AI Power Grid for OpenClaw

Unofficial, community-built. Adds [AI Power Grid](https://aipowergrid.io) to [OpenClaw](https://openclaw.ai):
a network of independent GPU operators behind one OpenAI-compatible API, paid per use from a prepaid balance or
a daily free allowance.

What the plugin adds:

- **Images** for OpenClaw's `image_generate` tool, from $0.003 per image, including edits of an existing image.
  This works next to any main model, and only the prompt (and the source image of an edit) goes to the grid.
- **Video** for `video_generate`, $0.02 per second of video.
- **Text models** as a model provider for the agent itself.
- **Two tools**: `aipg_council` puts a question to several grid models and reports whether they agree;
  `aipg_balance` shows the credit.
- **Wallet sign-in and funding**: an account, an API key and credit from a Base wallet, without a browser.

[![test](https://github.com/speteai/openclaw-aipg-provider/actions/workflows/test.yml/badge.svg)](https://github.com/speteai/openclaw-aipg-provider/actions/workflows/test.yml)

The model list is not written into the plugin. It is read from the grid's public status endpoint, so OpenClaw
offers the text models that are online at that moment and large enough for an agent.

## Install

```bash
openclaw plugins install clawhub:openclaw-aipg-provider --accept-capabilities
```

### Getting a key

The grid's documentation asks for a person to create the account and the key: sign in once in the
[AIPG Console](https://console.aipowergrid.io/?callbackUrl=%2Fdashboard%2Fapi-key) with Google, GitHub or a
wallet and creates an API key there (it starts with `grid_`). New accounts with a verified Google sign-in get a
small daily free allowance; beyond that the account needs credit.

Give the key to OpenClaw in one of these ways:

```bash
export AIPG_API_KEY=grid_...                              # environment variable
openclaw models auth paste-api-key --provider aipg        # stored in OpenClaw's auth store (reads the key from stdin)
openclaw onboard --aipg-api-key grid_...                  # or during onboarding
```

Without a key OpenClaw reports `No API key found for provider "aipg"`; with a wrong one, a sign-in error.

### Signing in with a wallet instead

The grid also signs you in with a wallet on Base, and this needs no browser: the plugin asks the grid for a
sign-in message, signs it with the wallet key and sends it back. If the wallet is new to the grid, the account
is created at that moment. The grid then issues an API key, and only that key is stored by OpenClaw. The wallet
key is used in memory for the one signature and is not written anywhere.

In a terminal:

```bash
export AIPG_WALLET_PRIVATE_KEY=0x...     # or leave it unset and answer the prompt
openclaw models auth login --provider aipg --method wallet
```

Without a terminal (automation, an agent that holds its own wallet):

```bash
DIR="$(openclaw plugins inspect aipg --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("{"))).plugin.rootDir))')"
AIPG_WALLET_PRIVATE_KEY=0x... node "$DIR/bin/wallet-login.js" | openclaw models auth paste-api-key --provider aipg
```

`wallet-login.js` prints the API key on stdout and what a person should read on stderr.

Things to know:

- **Credit.** A wallet account starts with no credit and no free allowance, so requests are refused with HTTP
  402 until it is funded. A wallet that holds 10,000 AIPG or more gets a daily free allowance instead.

#### Adding credit from the wallet

`bin/wallet-fund.js` sends USDC on Base from the wallet to the grid's treasury and reports the transaction, so
the credit appears on the account:

```bash
export AIPG_WALLET_PRIVATE_KEY=0x...  AIPG_API_KEY=grid_...
node "$DIR/bin/wallet-fund.js" --amount 0.5          # shows the plan and sends nothing
node "$DIR/bin/wallet-fund.js" --amount 0.5 --yes    # sends
```

It moves money, and grid credit cannot be withdrawn or moved to another account. So it is built to refuse:

- nothing is sent without `--yes`;
- never more than `AIPG_FUND_MAX_USDC` (default 5 USDC) in one run;
- only if the grid confirms that the API key's account belongs to this wallet, otherwise the deposit would not
  be credited;
- only to the treasury address the grid reports, only USDC at its fixed contract address on Base, only when the
  RPC endpoint (`AIPG_BASE_RPC`, default `https://mainnet.base.org`) really is Base.

The wallet needs a little ETH on Base for the fee (well under a cent). There is no tool for this that the model
can call by itself: an agent has to run the command, which OpenClaw's own approval of shell commands governs.
- **Every sign-in creates another API key.** The API offers no way to list or revoke keys; that is done in the
  Console.
- **The wallet key is a secret that controls funds.** Use a wallet that holds only what the agent may spend.
- This is the sign-in the grid's own Console uses. The grid's documentation describes the Console route for
  people and does not mention this one for programs.

### Images

With the key in place, ask the agent for an image. To make the grid the default for images:

```json5
// ~/.openclaw/openclaw.json
{ agents: { defaults: { mediaModels: { image: { primary: "aipg/z-image-turbo" } } } } }
```

Image models and list prices at the time of writing: `z-image-turbo` $0.003, `Krea 2 Turbo` $0.005,
`FLUX.2 Klein 4B FP8` $0.01, `MOSS Image SFT BF16` $0.01. Sizes: 1024x1024, 1344x768, 768x1344, 1216x832,
832x1216; up to four images per call. To edit, give the tool one source image (up to 12 MB) and say what to
change.

### Video

```json5
{ agents: { defaults: { mediaModels: { video: { primary: "aipg/LTX-2.5 Distilled BF16" } } } } }
```

Up to 26 seconds per video, from a prompt or from one source image. The plugin submits a job and asks every few
seconds until it is done; a 2-second video took about 25 seconds. Before submitting it sets a cost ceiling of
the list price plus a quarter, and the grid charges what the job actually cost.

### The council and the balance

`aipg_council` sends one question to every text model online (up to four). Each answers on its own, the largest
one writes a joint answer and a verdict: agree, partly, differ. It costs one request per model plus one, well
under a cent. Agreement is not proof: models can share a mistake.

`aipg_balance` reports spendable credit, today's free allowance and the purchased balance. It is free.

### Text model for the agent

```bash
openclaw models set aipg/qwen38-flash-next-nvfp4
```

## What was tested

OpenClaw 2026.11.3 on Linux against the live grid, 2026-11-13, with the embedded agent
(`openclaw agent --local`):

| Model | Plain question | Read a file | Fix a Python file and run it |
| --- | --- | --- | --- |
| `qwen38-flash-next-nvfp4` | correct | correct | correct (5 model calls, 59 s) |
| `gpt-oss-120b` | correct | failed in 4 of 4 runs (tool call) | not tried |

Images, through the agent's `image_generate` tool:

| Request | Result |
| --- | --- |
| One image, default model (`z-image-turbo`) | 1024x1024 WebP saved by OpenClaw, $0.003 |
| Two images, `FLUX.2 Klein 4B FP8`, 1344x768 | two WebP files, $0.02 |
| A model name that does not exist | no image, nothing charged for it |

So at the time of writing one text model is usable for agent work. The plugin lists `gpt-oss-120b` too, with a
note in its label, because it answers plain questions.

Added in 0.5.0, each checked against the live grid: an image edit through the agent (a lighthouse picture
turned into a winter scene, same composition), a 2-second video with `openclaw infer video generate` (MP4,
28 s, $0.04), the two tools through agent turns, and `wallet-fund.js` (0.1 USDC sent, claimed and credited; the
refusals for a missing `--yes`, an amount above the limit, a key of another account and too little USDC). The
transaction code was compared with viem on 40 random transactions. In `openclaw agent --local`, which exits
after one turn, a video is not delivered because the process ends before the job does; with the gateway
running this should not happen, but that was not tested.

A GitHub workflow installs the packed plugin into a fresh OpenClaw on Linux, Windows and macOS and checks that
it loads with all capabilities, tools and the skill. It makes no paid call, so on Windows and macOS the paid
paths themselves are not exercised.

Wallet sign-in, with a wallet that was created for the test: a new account and key from nothing but the
wallet, 0.5 USDC deposited and claimed, then paid calls; `models auth login --method wallet` in a terminal and
`wallet-login.js` piped into `paste-api-key`, each followed by an agent turn on the new key. The signature code
was compared with viem on 25 random keys.

The install from ClawHub was checked the same way on a fresh OpenClaw home (version 0.1.0: install, model list,
`models set`, file read). Also checked: a key stored with `models auth paste-api-key`, the messages without a key
and with a wrong key, and a session of four turns that each read a 55,000-character file. In that session the
grid refused one request as too large; OpenClaw compacted the conversation by itself and the turn succeeded.

Not tested: paid calls on Windows and macOS, the gateway daemon, chat channels, the interactive onboarding
prompt, video from a source image.

## What it costs

OpenClaw sends its instructions and tool descriptions with every model call. Measured on the grid:

| Turn | Input tokens sent | Charged |
| --- | --- | --- |
| Plain question | about 17,000 | $0.0009 |
| Read one file | about 30,000 | $0.002 |
| Fix a file and run it | about 86,000 | $0.005 |
| Four turns, each reading a 55,000-character file | not reported for every turn | $0.018 in total |

List prices at the time were $0.075 per million input tokens and $0.30 per million output tokens; the plugin
passes the live prices to OpenClaw.

## Limits you should know

- **Request size.** The grid refuses a request above 200,000 characters, whatever the model could hold. The
  plugin therefore advertises a context window of 40,000 tokens, so OpenClaw compacts the conversation before
  the grid turns it away. If a request is refused all the same, OpenClaw compacts and retries.
- **Rate limit.** 30 chat requests per minute per account.
- **Small models are left out.** Models with a context below 32,000 tokens are not listed: an agent turn does
  not fit.
- **Availability.** Models come and go with the operators that are online. A model missing from the list is
  offline or too small.

## Privacy

For images, the grid sees the image prompt and nothing else. For the text provider it is different: whatever
OpenClaw sends to its model goes to the grid and is processed in plain text on a computer run by an
independent operator. With the grid as the main model, that includes your messages, files the agent reads and
tool results. Do not use it for content that must stay confidential.

If you only want the grid for single tasks next to another main model, the
[AIPG Desktop](https://github.com/speteai/aipg-desktop) connector is the better fit: it adds grid tools to
OpenClaw over MCP and masks private values before they leave the machine.

## What the plugin sends

Model requests carry one extra header, `X-AIPG-Client: openclaw-aipg-provider/<version>`. It lets the grid's
operators see how much traffic comes from OpenClaw. It names the client and nothing about you, and the plugin
itself collects nothing and reports to nobody else.

## The skill

The plugin ships a skill, `ai-power-grid`, that tells the agent how to use the grid: how the user gets a key
(the agent never asks for it in the chat), which image and text models to call, what the errors mean and what
to say about cost and privacy. The same skill is published on its own on ClawHub; without the plugin it guides
the agent through plain HTTP calls. Tested that way: the agent read the skill, generated an image with `curl`,
saved it in the workspace and reported the price.

## Audio and 3D

Not covered by this plugin. The grid publishes its own
[agent skill and MCP server](https://github.com/AIPowerGrid/grid-skill) for those.

## How it works

- `index.js` registers the provider `aipg` with API-key auth (`AIPG_API_KEY`, `--aipg-api-key`).
- `video.js` registers the video provider on the grid's job API (`/v1/videos/jobs`), `tools.js` the two tools.
- `tx.js` builds and signs the one kind of transaction funding needs (an EIP-1559 ERC-20 transfer).
- `wallet.js` implements the wallet sign-in (EIP-191 signature with `@noble/curves` and `@noble/hashes`, the
  plugin's only dependencies); `bin/wallet-login.js` is the same without a prompt.
- `images.js` registers the image provider: it checks which image models are online, posts to
  `/v1/images/generations` and hands the image bytes to OpenClaw.
- The catalog reads `GET https://api.aipowergrid.io/v1/status/models` (public, no key), keeps text models that
  are online with a context of at least 32,000 tokens, and maps their published prices. The result is cached
  for one minute. If the grid cannot be reached, the tested default model is offered.
- Requests go to `https://api.aipowergrid.io/v1` with the OpenAI chat-completions format.

## License

MIT. Not affiliated with AI Power Grid or OpenClaw.

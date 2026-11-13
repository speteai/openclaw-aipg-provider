# AI Power Grid provider for OpenClaw

Unofficial, community-built. Adds [AI Power Grid](https://aipowergrid.io) as a model provider to
[OpenClaw](https://openclaw.ai): a network of independent GPU operators behind one OpenAI-compatible API,
paid per token from a prepaid balance or a daily free allowance.

The model list is not written into the plugin. It is read from the grid's public status endpoint, so OpenClaw
offers the text models that are online at that moment and large enough for an agent.

## Install

```bash
openclaw plugins install clawhub:openclaw-aipg-provider --accept-capabilities
```

### Getting a key

An agent cannot create the account by itself, and that is intended by the grid: a person signs in once in the
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

Then choose the model:

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

So at the time of writing one model is usable for agent work. The plugin lists `gpt-oss-120b` too, with a
note in its label, because it answers plain questions.

The install from ClawHub was checked the same way on a fresh OpenClaw home (version 0.1.0: install, model list,
`models set`, file read). Also checked: a key stored with `models auth paste-api-key`, the messages without a key
and with a wrong key, and a session of four turns that each read a 55,000-character file. In that session the
grid refused one request as too large; OpenClaw compacted the conversation by itself and the turn succeeded.

Not tested: Windows and macOS, the gateway daemon, chat channels, the interactive onboarding prompt.

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

Whatever OpenClaw sends to its model goes to the grid and is processed in plain text on a computer run by an
independent operator. With the grid as the main model, that includes your messages, files the agent reads and
tool results. Do not use it for content that must stay confidential.

If you only want the grid for single tasks next to another main model, the
[AIPG Desktop](https://github.com/speteai/aipg-desktop) connector is the better fit: it adds grid tools to
OpenClaw over MCP and masks private values before they leave the machine.

## What the plugin sends

Model requests carry one extra header, `X-AIPG-Client: openclaw-aipg-provider/<version>`. It lets the grid's
operators see how much traffic comes from OpenClaw. It names the client and nothing about you, and the plugin
itself collects nothing and reports to nobody else.

## Images, video and other grid features

This plugin covers text models for the agent itself. For image, video, audio and 3D generation the grid
publishes its own [agent skill and MCP server](https://github.com/AIPowerGrid/grid-skill).

## How it works

- `index.js` registers the provider `aipg` with API-key auth (`AIPG_API_KEY`, `--aipg-api-key`).
- The catalog reads `GET https://api.aipowergrid.io/v1/status/models` (public, no key), keeps text models that
  are online with a context of at least 32,000 tokens, and maps their published prices. The result is cached
  for one minute. If the grid cannot be reached, the tested default model is offered.
- Requests go to `https://api.aipowergrid.io/v1` with the OpenAI chat-completions format.

## License

MIT. Not affiliated with AI Power Grid or OpenClaw.

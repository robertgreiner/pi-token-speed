# Pi Token Speed

Provider-neutral, client-observed token throughput for [Pi](https://pi.dev). Requires
Pi 1.3.0+. It never changes models, thinking, tiers, tools, or request payloads.

## Install

```sh
pi install git:github.com/robertgreiner/pi-token-speed
```

Then `/reload` in running sessions. Enabled by default:

```text
/tokens
/tokens status
/tokens off
/tokens on
```

Change the toggle while idle. It persists on the session branch. Measurements are
in memory only, reset on reload, branch navigation, idle model change, or a new turn.

## Display

Shows `waiting…`, `thinking…`, or `streaming…` while a request runs, then:

```text
↓ 111.3 tok/s
```

With the optional [Pi OpenAI Speed](https://github.com/robertgreiner/pi-openai-speed)
footer active, it appears inline:

```text
gpt-6-astra • xhigh • ultrafast • ↓ 111.3 tok/s
```

Without that footer it uses Pi's normal extension status row. It does not replace
any footer. Other custom footers must render extension statuses to display it.

## What tok/s means

OpenCode-style **turn-wide provider-active throughput**:

```text
sum(output tokens, including reasoning) / sum(successful request durations)
```

Counts and durations are summed before division, not averaged as per-request rates.
Each duration runs from Pi's `before_provider_request` hook to the final assistant
message, including startup, queueing, and reasoning. Pi's output count already
includes reasoning; it is not added twice. Zero-output successful requests still
contribute their duration. Tool-call output counts too.

A turn includes model/tool steps and automatic continuations until `agent_settled`.
Model changes during a turn preserve its aggregate. A retry resets its attempt's
clock while retaining earlier successful requests. Failed attempts and retry
backoff are excluded; errors and aborts hide the rate. A successful request without
valid timing or usage suppresses the turn rate rather than showing a misleading
average over only part of the turn.

**This is not wall-clock task speed.** Tool execution, external classifiers, approval
waits, and time between requests do not contribute. Measure complete task time and
correctness when evaluating workflow optimizations.

`/tokens status` also shows the latest request's:

- full-request output rate;
- first-text latency;
- approximate visible-text burst rate, where measurable.

The burst rate subtracts reported reasoning tokens and divides by the interval
between first and last visible text deltas. It excludes initial latency and is
unreliable for short/buffered replies. No burst rate is claimed for tool calls,
unknown reasoning counts, a single chunk, or incomplete text. Stream chunks and
characters are never treated as tokens. No extra API calls are made.

Virtual model routers should be verified separately: the current timing observer
matches the selected provider/model to assistant messages and assumes a physical
model selection. It does not claim routing-aware measurements.

## Migration from pi-openai-speed

This extension was extracted from `pi-openai-speed` v0.4.0 without changing its
commands or persisted state. Update the old package first, then install this one:

```sh
pi update git:github.com/robertgreiner/pi-openai-speed
pi install git:github.com/robertgreiner/pi-token-speed
```

Then `/reload` once. OpenAI Speed v0.5.0+ no longer loads the bundled copy. Do not
load this alongside the old `token-speed.ts` or a manual copy: duplicate observers
and `/tokens` commands are invalid. No session-history edits are needed.

Compatibility contracts retained:

- branch entry: `token-speed-state`;
- footer status: `token-speed`;
- local event: `token-speed:sample` (same per-request numeric sample shape).

Samples contain provider/model names and numeric metadata only, never prompts,
response text, IDs, headers, or credentials. No network telemetry or disk log is
created by this extension.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

CI tests Node 22/24/26 without credentials or model requests. Tests cover weighted
aggregation, reasoning, tools, retry/settlement boundaries, errors, zero output,
missing usage, branch toggles, and request immutability. Pi supplies runtime peers.

MIT. Extracted from Robert Greiner's Pi OpenAI Speed; not affiliated with Pi or OpenAI.

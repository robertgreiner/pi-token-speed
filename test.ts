import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import tokenSpeed, { finishTokens, tokenLabel, type TokenTiming } from "./index.ts";

const timing: TokenTiming = { provider: "test-provider", model: "test-model", startedAt: 0, firstTextAt: 1000, lastTextAt: 3000, stage: "streaming" };
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: "openai-responses", provider: timing.provider, model: timing.model,
    content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "private text" }],
    usage: { input: 50, output: 120, reasoning: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 170, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0, ...overrides,
  };
}

function harness() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  const samples: unknown[] = [];
  let time = 0;
  let status: string | undefined;
  const ctx = {
    model: { provider: timing.provider, id: timing.model },
    ui: { setStatus: (_key: string, value: string | undefined) => { status = value; }, notify: (text: string) => notifications.push(text) },
    sessionManager: { getBranch: () => entries },
  };
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, fn),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    events: { emit: (event: string, data: unknown) => { assert.equal(event, "token-speed:sample"); samples.push(data); } },
  };
  tokenSpeed(pi as any, () => time);
  const call = (event: string, data: unknown = {}) => handlers.get(event)!(data, ctx);
  return {
    call, ctx, entries, samples, notifications, status: () => status,
    at: (t: number) => { time = t; },
    delta: (t: number, type = "text_delta", delta = "private") => {
      time = t;
      call("message_update", { message: message(), assistantMessageEvent: { type, delta } });
    },
    command: (args: string) => commands.get("tokens").handler(args, ctx),
  };
}

test("normalized provider usage measures text separately from total output and latency", () => {
  const sample = finishTokens(timing, message(), 4000)!;
  assert.equal(sample.textTokensPerSecond, 50);
  assert.equal(sample.totalTokensPerSecond, 30);
  assert.equal(sample.visibleTokens, 100);
  assert.equal(sample.firstTextSeconds, 1);
  assert.equal(tokenLabel(sample), "↓ 30.0 tok/s");
  assert.doesNotMatch(JSON.stringify(sample), /private/);
});

test("missing or invalid reasoning usage, tool calls and truncation use the same total-throughput metric", () => {
  const base = message();
  const cases = [
    message({ usage: { ...base.usage, reasoning: undefined } }),
    message({ usage: { ...base.usage, reasoning: -1 } }),
    message({ usage: { ...base.usage, reasoning: 121 } }),
    message({ usage: { ...base.usage, reasoning: NaN } }),
    message({ content: [...base.content, { type: "toolCall", id: "private-id", name: "read", arguments: {} }], stopReason: "toolUse" }),
    message({ stopReason: "length" }),
  ];
  for (const m of cases) {
    const sample = finishTokens(timing, m, 4000)!;
    assert.equal(sample.textTokensPerSecond, undefined);
    assert.equal(tokenLabel(sample), "↓ 30.0 tok/s");
  }
  const noReasoning = finishTokens(timing, message({ usage: { ...base.usage, reasoning: 0 } }), 4000)!;
  assert.equal(noReasoning.textTokensPerSecond, 60);
});

test("single-chunk and no-text responses never get a fabricated text rate", () => {
  for (const t of [{ ...timing, lastTextAt: timing.firstTextAt }, { ...timing, firstTextAt: undefined, lastTextAt: undefined }]) {
    assert.equal(finishTokens(t, message(), 4000)!.textTokensPerSecond, undefined);
  }
  const thinkingOnly = message({ content: [{ type: "thinking", thinking: "private" }] });
  assert.equal(finishTokens(timing, thinkingOnly, 4000)!.textTokensPerSecond, undefined);
});

test("errors, aborts, absent usage and invalid timing do not produce samples", () => {
  for (const stopReason of ["error", "aborted", "pending"] as const) assert.equal(finishTokens(timing, message({ stopReason }), 4000), undefined);
  for (const output of [-1, NaN, Infinity, undefined]) assert.equal(finishTokens(timing, message({ usage: { ...message().usage, output: output as number } }), 4000), undefined);
  assert.equal(finishTokens(timing, message({ usage: { ...message().usage, output: 0 } }), 4000)!.totalTokensPerSecond, 0);
  assert.equal(finishTokens(timing, message(), 0), undefined);
  assert.equal(finishTokens(timing, message(), -1), undefined);
});

test("standalone extension observes any model, preserves request payload and shows phases until final usage", () => {
  const h = harness(); h.call("session_start");
  const payload = { model: timing.model, service_tier: "anything", reasoning: { effort: "high" }, input: ["private"] };
  const copy = structuredClone(payload);
  assert.equal(h.call("before_provider_request", { payload }), undefined);
  assert.deepEqual(payload, copy);
  assert.equal(h.status(), "↓ waiting…");
  h.delta(500, "thinking_delta"); assert.equal(h.status(), "↓ thinking…");
  h.delta(1000); assert.equal(h.status(), "↓ streaming…");
  const final = message();
  h.delta(3000); h.at(4000); h.call("message_end", { message: final });
  assert.equal(h.status(), "↓ 30.0 tok/s");
  h.call("message_end", { message: final }); h.call("agent_end");
  h.call("agent_settled", { aborted: false });
  assert.equal(h.samples.length, 1);
  assert.equal(h.status(), "↓ 30.0 tok/s");
  assert.doesNotMatch(JSON.stringify(h.samples), /private/);
});

test("a retry replaces timing and a new request excludes prior tool execution time", () => {
  const h = harness();
  h.call("before_provider_request"); h.delta(500);
  h.at(1000); h.call("before_provider_request");
  h.delta(2000); h.delta(4000); h.at(5000); h.call("message_end", { message: message() });
  assert.equal((h.samples[0] as any).elapsedSeconds, 4);
  h.at(20000); h.call("before_provider_request");
  h.delta(21000); h.delta(23000); h.at(24000); h.call("message_end", { message: message() });
  assert.equal((h.samples[1] as any).elapsedSeconds, 4);
  assert.equal(h.status(), "↓ 30.0 tok/s");
});

test("unrelated messages are ignored, empty deltas do not count, and failed requests clear placeholders", () => {
  const h = harness(); h.call("before_provider_request");
  h.delta(1000, "text_delta", ""); assert.equal(h.status(), "↓ waiting…");
  h.call("message_end", { message: { role: "user", content: "private" } });
  h.call("message_end", { message: message({ model: "other" }) });
  h.delta(3000); h.at(4000); h.call("message_end", { message: message() });
  assert.equal(h.status(), "↓ 30.0 tok/s");
  h.call("before_provider_request"); h.at(5000); h.call("message_end", { message: message({ stopReason: "aborted" }) });
  assert.equal(h.status(), undefined);
  h.call("before_provider_request"); h.call("agent_end"); assert.equal(h.status(), undefined);
});

test("toggle persists on branch, restoring a branch or switching model drops stale measurements", async () => {
  const h = harness(); h.call("session_start");
  await h.command("off"); h.call("session_start"); h.call("before_provider_request");
  assert.equal(h.status(), undefined);
  h.entries.length = 0; h.call("session_tree"); h.call("before_provider_request");
  assert.equal(h.status(), "↓ waiting…");
  h.call("agent_end"); h.call("agent_settled", { aborted: false });
  h.call("model_select"); assert.equal(h.status(), undefined);
  h.call("before_provider_request"); h.call("session_shutdown"); assert.equal(h.status(), undefined);
  await h.command("invalid"); assert.equal(h.entries.length, 0);
  await h.command("on"); assert.equal(h.entries.length, 1);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /No measured response yet/);
});

test("status explains both metrics without including response text", async () => {
  const h = harness(); h.call("before_provider_request");
  h.delta(1000); h.delta(3000); h.at(4000); h.call("message_end", { message: message() });
  await h.command("");
  const status = h.notifications.at(-1)!;
  assert.match(status, /Turn so far: 30.0 tok\/s; 120 output tokens \/ 4.00s across 1 request/);
  assert.match(status, /Visible text: 50.0 tok\/s/);
  assert.match(status, /Total: 30.0 output tok\/s/);
  assert.match(status, /First text: 1.00s/);
  assert.doesNotMatch(status, /private/);
});

function completeRequest(h: ReturnType<typeof harness>, start: number, end: number, output: number, reasoning = 0) {
  h.at(start); h.call("before_provider_request");
  h.at(end); h.call("message_end", { message: message({
    provider: h.ctx.model.provider, model: h.ctx.model.id,
    usage: { ...message().usage, output, reasoning },
  }) });
}

test("matches OpenCode's multi-step fixture including reasoning, model changes, and no tool time", async () => {
  const h = harness(); h.call("before_agent_start");
  completeRequest(h, 6000, 10000, 25, 5);
  h.ctx.model.provider = "other-provider"; h.ctx.model.id = "other-model";
  h.call("model_select");
  completeRequest(h, 24000, 30000, 40, 10);
  h.at(31000); h.call("agent_end"); h.call("agent_settled", { aborted: false });
  assert.equal(h.status(), "↓ 6.5 tok/s");
  await h.command("status");
  assert.match(h.notifications.at(-1)!, /Turn: 6.5 tok\/s; 65 output tokens \/ 10.00s across 2 requests/);
});

test("aggregates counts and durations, never the arithmetic mean of request rates", () => {
  const h = harness(); h.call("before_agent_start");
  completeRequest(h, 0, 1000, 100);
  assert.equal(h.status(), "↓ 100.0 tok/s");
  completeRequest(h, 20000, 29000, 100);
  assert.equal(h.status(), "↓ 20.0 tok/s");
});

test("zero-output successful requests contribute their duration instead of inflating the turn rate", () => {
  const h = harness(); h.call("before_agent_start");
  completeRequest(h, 0, 1000, 0);
  assert.equal(h.status(), undefined);
  completeRequest(h, 2000, 5000, 120);
  assert.equal(h.status(), "↓ 30.0 tok/s");
});

test("automatic continuation and failed retries keep prior successful steps but exclude retry backoff", () => {
  const h = harness(); h.call("before_agent_start");
  completeRequest(h, 0, 1000, 100);
  h.call("agent_end");
  h.at(2000); h.call("before_provider_request");
  h.at(9000); h.call("message_end", { message: message({ stopReason: "error" }) });
  h.call("agent_end"); assert.equal(h.status(), undefined);
  completeRequest(h, 20000, 23000, 100);
  assert.equal(h.status(), "↓ 50.0 tok/s");
  assert.equal(h.samples.length, 2);
});

test("settlement and the next prompt reset the aggregate, but individual agent loops do not", async () => {
  const h = harness(); h.call("before_agent_start");
  completeRequest(h, 0, 1000, 100);
  h.call("agent_end");
  completeRequest(h, 2000, 5000, 100);
  assert.equal(h.status(), "↓ 50.0 tok/s");
  h.call("agent_settled", { aborted: false });
  h.call("before_agent_start"); assert.equal(h.status(), undefined);
  completeRequest(h, 10000, 14000, 40);
  assert.equal(h.status(), "↓ 10.0 tok/s");
  await h.command("status");
  assert.match(h.notifications.at(-1)!, /across 1 request\./);
});

test("an unmeasured successful step suppresses a misleading partial turn rate", async () => {
  for (const noTiming of [false, true]) {
    const h = harness(); h.call("before_agent_start");
    completeRequest(h, 0, 1000, 100);
    if (!noTiming) { h.at(2000); h.call("before_provider_request"); }
    h.at(5000); h.call("message_end", { message: message({
      usage: { ...message().usage, output: noTiming ? 100 : NaN },
    }) });
    completeRequest(h, 10000, 11000, 100);
    h.call("agent_settled", { aborted: false });
    assert.equal(h.status(), undefined);
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /Turn throughput unavailable/);
  }
});

test("aborting between requests clears the turn display and branch changes drop the aggregate", () => {
  const h = harness(); h.call("before_agent_start");
  completeRequest(h, 0, 1000, 100);
  h.call("agent_settled", { aborted: true }); assert.equal(h.status(), undefined);
  h.call("session_tree");
  completeRequest(h, 2000, 6000, 40);
  assert.equal(h.status(), "↓ 10.0 tok/s");
});

test("display toggles wait for settlement so enabling midway cannot report a partial turn", async () => {
  const h = harness(); h.call("before_agent_start");
  await h.command("off");
  assert.equal(h.entries.length, 0);
  assert.match(h.notifications.at(-1)!, /Wait for the current turn/);
  h.call("agent_settled", { aborted: false });
  await h.command("off"); h.call("before_agent_start");
  completeRequest(h, 0, 1000, 100);
  assert.equal(h.status(), undefined);
  assert.equal(h.samples.length, 0);
});

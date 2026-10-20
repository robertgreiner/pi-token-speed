/** Standalone, provider-neutral throughput display. Never modifies a model request. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const TOKEN_SPEED_STATUS = "token-speed";
const ENTRY = "token-speed-state";

export interface TokenTiming {
  provider: string;
  model: string;
  startedAt: number;
  firstTextAt?: number;
  lastTextAt?: number;
  stage: "waiting" | "thinking" | "streaming";
}

export interface TokenSample {
  provider: string;
  model: string;
  outputTokens: number;
  reasoningTokens?: number;
  visibleTokens?: number;
  elapsedSeconds: number;
  firstTextSeconds?: number;
  textSeconds?: number;
  textTokensPerSecond?: number;
  totalTokensPerSecond: number;
}

export function finishTokens(timing: TokenTiming, message: AssistantMessage, now: number): TokenSample | undefined {
  if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending") return;
  const output = message.usage.output;
  const elapsed = (now - timing.startedAt) / 1000;
  if (!Number.isFinite(output) || output < 0 || !Number.isFinite(elapsed) || elapsed <= 0) return;
  const reasoning = message.usage.reasoning;
  const hasBreakdown = reasoning !== undefined && Number.isFinite(reasoning) && reasoning >= 0 && reasoning <= output;
  const textOnly = message.content.some((part) => part.type === "text")
    && message.content.every((part) => part.type === "text" || part.type === "thinking");
  const visibleTokens = hasBreakdown && textOnly ? output - reasoning : undefined;
  const textSeconds = timing.firstTextAt !== undefined && timing.lastTextAt !== undefined
    ? (timing.lastTextAt - timing.firstTextAt) / 1000 : undefined;
  return {
    provider: message.provider,
    model: message.model,
    outputTokens: output,
    reasoningTokens: hasBreakdown ? reasoning : undefined,
    visibleTokens,
    elapsedSeconds: elapsed,
    firstTextSeconds: timing.firstTextAt === undefined ? undefined : (timing.firstTextAt - timing.startedAt) / 1000,
    textSeconds,
    // Length-limited responses still have trustworthy total usage, but don't claim a complete text sample.
    textTokensPerSecond: message.stopReason === "stop" && visibleTokens !== undefined && visibleTokens > 0
      && textSeconds !== undefined && textSeconds > 0 ? visibleTokens / textSeconds : undefined,
    totalTokensPerSecond: output / elapsed,
  };
}

export function tokenLabel(sample: Pick<TokenSample, "totalTokensPerSecond">): string {
  return `↓ ${sample.totalTokensPerSecond.toFixed(1)} tok/s`;
}

export default function tokenSpeed(pi: ExtensionAPI, now = () => performance.now()) {
  let enabled = true;
  let running = false;
  let active: TokenTiming | undefined;
  let last: TokenSample | undefined;
  let turn = { requests: 0, outputTokens: 0, elapsedSeconds: 0 };
  let complete = true;
  let failed = false;
  let seen = new WeakSet<AssistantMessage>();

  function clear(ctx: ExtensionContext) {
    running = false;
    active = undefined;
    last = undefined;
    turn = { requests: 0, outputTokens: 0, elapsedSeconds: 0 };
    complete = true;
    failed = false;
    seen = new WeakSet();
    ctx.ui.setStatus(TOKEN_SPEED_STATUS, undefined);
  }

  function turnRate(): number | undefined {
    const rate = turn.outputTokens / turn.elapsedSeconds;
    return complete && !failed && turn.outputTokens > 0 && Number.isFinite(rate) ? rate : undefined;
  }

  function showTurn(ctx: ExtensionContext) {
    const rate = turnRate();
    ctx.ui.setStatus(TOKEN_SPEED_STATUS, rate === undefined ? undefined : tokenLabel({ totalTokensPerSecond: rate }));
  }

  function restore(ctx: ExtensionContext) {
    clear(ctx);
    enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data = entry.data as { enabled?: unknown } | undefined;
      if (typeof data?.enabled === "boolean") enabled = data.enabled;
    }
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => {
    // Model changes between steps still belong to this turn, as in OpenCode.
    if (!running) clear(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
  pi.on("before_agent_start", (_event, ctx) => {
    clear(ctx);
    running = true;
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (!enabled || !ctx.model) return;
    // Also supports runs resumed without a new prompt. Retries replace only this
    // attempt's clock, not the successful steps already accumulated in the turn.
    if (!running) clear(ctx);
    running = true;
    active = { provider: ctx.model.provider, model: ctx.model.id, startedAt: now(), stage: "waiting" };
    ctx.ui.setStatus(TOKEN_SPEED_STATUS, "↓ waiting…");
  });

  pi.on("message_update", (event, ctx) => {
    if (!active || event.message.role !== "assistant"
      || event.message.provider !== active.provider || event.message.model !== active.model) return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" && update.delta.length > 0) {
      const at = now();
      active.firstTextAt ??= at;
      active.lastTextAt = at;
      if (active.stage !== "streaming") {
        active.stage = "streaming";
        ctx.ui.setStatus(TOKEN_SPEED_STATUS, "↓ streaming…");
      }
    } else if (update.type === "thinking_delta" && active.stage === "waiting") {
      active.stage = "thinking";
      ctx.ui.setStatus(TOKEN_SPEED_STATUS, "↓ thinking…");
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (!enabled || !running || message.role !== "assistant" || seen.has(message)) return;
    if (active && (message.provider !== active.provider || message.model !== active.model)) return;
    seen.add(message);
    failed = message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "pending";
    last = active ? finishTokens(active, message, now()) : undefined;
    active = undefined;
    if (last) {
      // Pi's output count ALREADY includes reasoning. Sum counts and durations
      // before dividing; averaging per-request rates would overweight short calls.
      turn.requests++;
      turn.outputTokens += last.outputTokens;
      turn.elapsedSeconds += last.elapsedSeconds;
      // Preserve the per-request event contract and detailed text-stream metric.
      // Sanitized numeric metadata only. No text, prompts, IDs, headers, or credentials.
      pi.events.emit("token-speed:sample", last);
    } else if (!failed) {
      // Never present only the measurable subset as a complete turn's throughput.
      complete = false;
    }
    showTurn(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    // This is NOT the turn boundary: automatic retries and continuations may follow.
    if (active) {
      active = undefined;
      failed = true;
      showTurn(ctx);
    }
  });
  pi.on("agent_settled", (event, ctx) => {
    running = false;
    if (event.aborted || active) failed = true;
    active = undefined;
    showTurn(ctx);
  });

  pi.registerCommand("tokens", {
    description: "Turn-wide token throughput: on | off | status (includes per-request text speed)",
    getArgumentCompletions: (prefix) => ["on", "off", "status"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase() || "status";
      if (arg === "on" || arg === "off") {
        if (running) {
          ctx.ui.notify("Wait for the current turn to finish before changing the throughput display.", "warning");
          return;
        }
        enabled = arg === "on";
        clear(ctx);
        pi.appendEntry(ENTRY, { enabled });
        ctx.ui.notify(`Token throughput ${enabled ? "enabled for the next turn" : "hidden"}.`, "info");
        return;
      }
      if (arg !== "status") {
        ctx.ui.notify("Usage: /tokens on|off|status", "warning");
        return;
      }
      const lines = [`Token throughput display: ${enabled ? "on" : "off"} — turn-wide output including reasoning.`];
      const rate = turnRate();
      if (rate !== undefined) {
        lines.push(`Turn${running ? " so far" : ""}: ${rate.toFixed(1)} tok/s; ${turn.outputTokens} output tokens / ${turn.elapsedSeconds.toFixed(2)}s across ${turn.requests} request${turn.requests === 1 ? "" : "s"}.`);
      } else if (!complete || failed) {
        lines.push("Turn throughput unavailable: a request failed or lacks valid timing/usage.");
      }
      if (active) lines.push(`Request is ${active.stage}; waiting for final token usage.`);
      if (last) {
        lines.push(`Last request — ${last.provider}/${last.model}: ${last.outputTokens} output tokens${last.reasoningTokens === undefined ? "" : ` (${last.reasoningTokens} reasoning)`}.`);
        if (last.textTokensPerSecond !== undefined) lines.push(`Visible text: ${last.textTokensPerSecond.toFixed(1)} tok/s over ${last.textSeconds!.toFixed(2)}s of streaming.`);
        lines.push(`Total: ${last.totalTokensPerSecond.toFixed(1)} output tok/s over ${last.elapsedSeconds.toFixed(2)}s (includes startup and reasoning).`);
        if (last.firstTextSeconds !== undefined) lines.push(`First text: ${last.firstTextSeconds.toFixed(2)}s.`);
      } else if (!active) {
        lines.push("No measured response yet.");
      }
      lines.push("Turn rate = summed output tokens / summed request durations, including startup and reasoning. Tool gaps and failed retry attempts are excluded; not wall-clock task speed.");
      lines.push("Counts come from provider usage, not chunks or character estimates. Visible-text speed is a separate, approximate per-request burst metric.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

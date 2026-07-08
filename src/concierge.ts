import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { RATATOSKR_SOUL } from "./soul.js";
import type { TrackedMessage } from "./message-tracker.js";

export type TriageAction = "ready" | "clarify" | "answer";

/** Which runtime served (or attempted) a triage classification (issue #31). */
export type TriageBackend = "m5" | "anthropic";

/**
 * One routing attempt for a triage decision — the routing-outcome record the
 * Pillar-2 capability ledger learns from (issue #31). `errorClass` reuses the
 * gateway ledger's vocabulary (timeout/parse/infra) plus "policy" for a
 * gateway-side routing block (verdict said escalate; no local call ran).
 */
export interface TriageAttempt {
  backend: TriageBackend;
  model: string;
  outcome: "pass" | "error";
  errorClass?: "timeout" | "parse" | "infra" | "policy";
  latencyMs: number;
  /** Gateway capability-ledger row id, when the gateway recorded the attempt. */
  ledgerId?: string;
  /** Short failure description when outcome is "error". */
  error?: string;
}

/** Competence evidence for a single triage call (issues #27/#31) — serving
 *  backend + model, latency, token usage, and every routing attempt, so it can
 *  be logged to Munin and rolled up for /heimdall.json. */
export interface TriageMeta {
  model: string;
  /** Backend that served the final decision. */
  backend: TriageBackend;
  /** True when the M5 gateway was attempted but Anthropic served (degraded path). */
  fallback: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Every routing attempt, in order — ledger-ingestable outcome records. */
  attempts: TriageAttempt[];
}

export type TriageResult =
  | {
      action: "ready";
      task: { prompt: string; context: string; timeout: number; title: string };
      meta: TriageMeta;
    }
  | { action: "clarify"; question: string; meta: TriageMeta }
  | { action: "answer"; reply: string; meta: TriageMeta };

/** A parsed triage decision without the meta envelope. */
type TriageDecision =
  | {
      action: "ready";
      task: { prompt: string; context: string; timeout: number; title: string };
    }
  | { action: "clarify"; question: string }
  | { action: "answer"; reply: string };

const SYSTEM_PROMPT = `${RATATOSKR_SOUL}

You are a concierge for a personal AI infrastructure called Grimnir. You triage messages from the owner (Magnus) sent via Telegram on his phone. Messages may be terse.

You have context from Munin (the memory system) about active projects and tasks.

Your job: decide what to do with each message.

Respond with JSON only. One of three actions:

1. **ready** — The intent is clear enough to submit as a Hugin task.
   {"action": "ready", "task": {"prompt": "<enriched prompt for Claude Code>", "context": "<repo:name or scratch>", "timeout": <seconds>, "title": "<short slug>"}}
   - Enrich terse messages into clear prompts (e.g. "fix the css bug" → "Fix the CSS layout bug in the navbar component that was reported yesterday")
   - Use Munin context to fill in details the user left implicit — but if the repo, bug, or target is genuinely uncertain, prefer "clarify" over guessing
   - context should be "repo:<name>" for repo work, "scratch" for general tasks
   - timeout: 300 for quick fixes, 600 for moderate tasks, 1800 for large tasks

2. **clarify** — The message is ambiguous, you need more info.
   {"action": "clarify", "question": "<your question>"}

3. **answer** — Can be answered directly from context without a task.
   {"action": "answer", "reply": "<your reply>"}
   - Use for status checks, quick facts from Munin context, greetings, etc.

When the user sends an image (screenshot, photo, etc.):
- If it's a bug/error screenshot with a clear ask: classify as "ready" and describe what the image shows in the enriched task prompt. The Hugin agent cannot see the image, so your description must be detailed enough to act on.
- If the image is ambiguous and no caption explains intent: classify as "clarify" and ask what they want done with it.
- If you can answer directly from the image (e.g. "what does this error mean?"): classify as "answer".

If a Reply Context section is present, the user is responding to a specific previous message. Use that context to understand what they're referring to — e.g. "run this again" means resubmit the referenced task, "that's wrong" means the referenced result needs correction.

Always respond with valid JSON, no markdown fences.`;

export async function gatherContext(
  munin: MuninClient
): Promise<string> {
  const parts: string[] = [];

  try {
    const activeTasks = await munin.query({
      query: "task",
      namespace: "tasks/",
      tags: ["running"],
      limit: 3,
    });
    if (activeTasks.results.length > 0) {
      parts.push(
        "## Running tasks\n" +
          activeTasks.results
            .map(
              (r) =>
                `- ${r.namespace}/${r.key}: ${r.content_preview.slice(0, 100)}`
            )
            .join("\n")
      );
    }
  } catch {
    // Munin query failed — continue without this context
  }

  try {
    const recentProjects = await munin.query({
      query: "recent activity",
      namespace: "projects/",
      limit: 5,
    });
    if (recentProjects.results.length > 0) {
      parts.push(
        "## Recent project activity\n" +
          recentProjects.results
            .map(
              (r) =>
                `- ${r.namespace}: ${r.content_preview.slice(0, 120)}`
            )
            .join("\n")
      );
    }
  } catch {
    // Continue without project context
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : "No recent context available from Munin.";
}

/** Build the concierge system prompt: soul + instructions + Munin/reply context. */
function buildSystemContent(
  muninContext: string,
  replyContext?: TrackedMessage | null
): string {
  let systemContent = `${SYSTEM_PROMPT}\n\n## Current Munin Context\n${muninContext}`;

  if (replyContext) {
    if (replyContext.replyToText) {
      systemContent += `\n\n## Reply Context\nThe user is replying to an earlier message. That message said:\n"""${replyContext.replyToText}"""`;
    } else {
      const ref = replyContext.taskId
        ? `the ${replyContext.type} for task "${replyContext.taskId}"`
        : `a previous ${replyContext.type} message`;
      systemContent += `\n\n## Reply Context\nThe user is replying to ${ref}.`;
      if (replyContext.snippet) {
        systemContent += ` That message said: "${replyContext.snippet}"`;
      }
    }
  }

  return systemContent;
}

/**
 * Parse a model's triage output into a decision. `lenient` preserves the
 * historical Anthropic-path behavior of rescuing a bare {reply}/{question}
 * as an answer; the M5 path parses STRICTLY so a weak local model's junk
 * never silently serves — it falls back to Anthropic instead.
 * Throws when the text is not a usable decision.
 */
function parseTriageDecision(
  text: string,
  opts: { lenient: boolean }
): TriageDecision {
  // Strip markdown fences if the model wraps them anyway
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  // Validate structure
  if (parsed.action === "ready" && parsed.task?.prompt && parsed.task?.title) {
    return {
      action: "ready",
      task: {
        prompt: parsed.task.prompt,
        context: parsed.task.context || "scratch",
        timeout: parsed.task.timeout || 600,
        title: parsed.task.title,
      },
    };
  } else if (parsed.action === "clarify" && parsed.question) {
    return { action: "clarify", question: parsed.question };
  } else if (parsed.action === "answer" && parsed.reply) {
    return { action: "answer", reply: parsed.reply };
  }

  // Lenient rescue: treat as answer if we got something answer-shaped
  if (opts.lenient && (parsed.reply || parsed.question)) {
    return {
      action: "answer",
      reply: parsed.reply || parsed.question || "I couldn't parse that.",
    };
  }

  throw new Error(`Unexpected concierge response: ${text}`);
}

/**
 * Regex the gateway's `matches` verifier grades local triage output with, so
 * the capability ledger records a real pass/fail verdict per attempt instead
 * of "unverified". Deliberately looser than parseTriageDecision (it can't
 * check required per-action fields) — the strict parse still gates what
 * actually serves.
 */
const TRIAGE_VERIFIER_PATTERN = '"action"\\s*:\\s*"(ready|clarify|answer)"';

/** M5 gateway failure, classified with the ledger's error vocabulary. */
class M5TriageError extends Error {
  constructor(
    message: string,
    readonly errorClass: "timeout" | "parse" | "infra" | "policy",
    readonly ledgerId?: string
  ) {
    super(message);
    this.name = "M5TriageError";
  }
}

/** Subset of the gateway's DelegationOutcome that the triage path consumes. */
interface DelegationOutcome {
  delegated?: boolean;
  escalate?: boolean;
  decisionReason?: string;
  outcome?: string;
  output?: string;
  metrics?: { promptTokens?: number; completionTokens?: number };
  ledgerId?: string;
}

/**
 * Flatten conversation history + the new message into a single /delegate
 * prompt (the gateway's orchestrated path takes one prompt string, not a
 * messages array).
 */
function buildDelegatePrompt(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>
): string {
  if (conversationHistory.length === 0) return message;
  const transcript = conversationHistory
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  return `## Conversation so far\n${transcript}\n\n## New message\n${message}`;
}

/**
 * Classify via the M5 gateway's POST /delegate (issue #31). The gateway runs
 * the pinned local model, grades the output with the verifier, and records
 * the attempt in its capability ledger — the Pillar-2 routing-outcome feed.
 * Throws M5TriageError on ANY failure so triage() can fall back to Anthropic.
 */
async function triageViaM5(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  systemContent: string,
  fetchImpl: typeof fetch
): Promise<{
  decision: TriageDecision;
  promptTokens: number;
  completionTokens: number;
  ledgerId?: string;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.triageApiKey) {
    headers.Authorization = `Bearer ${config.triageApiKey}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(config.triageUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: buildDelegatePrompt(message, conversationHistory),
        systemPrompt: systemContent,
        taskType: "triage",
        modelId: config.triageModel,
        delegatorModelId: config.conciergeModel,
        maxTokens: 1024,
        // No frontierModelId: ratatoskr owns its own Anthropic fallback.
        verifier: { type: "matches", pattern: TRIAGE_VERIFIER_PATTERN },
      }),
      signal: AbortSignal.timeout(config.triageTimeoutMs),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new M5TriageError(
      isTimeout
        ? `gateway timed out after ${config.triageTimeoutMs}ms`
        : `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
      isTimeout ? "timeout" : "infra"
    );
  }

  if (!res.ok) {
    throw new M5TriageError(`gateway returned ${res.status}`, "infra");
  }

  let body: DelegationOutcome;
  try {
    body = (await res.json()) as DelegationOutcome;
  } catch {
    throw new M5TriageError("gateway returned invalid JSON", "infra");
  }

  if (body.delegated === false) {
    // Routing policy blocked the local call (e.g. ledger verdict not_viable).
    throw new M5TriageError(
      `gateway declined to delegate: ${body.decisionReason ?? "no reason given"}`,
      "policy",
      body.ledgerId
    );
  }
  if (body.delegated !== true) {
    // Contract fields missing entirely — a schema-drifted or wrong endpoint
    // response must never serve as a healthy M5 decision.
    throw new M5TriageError(
      "gateway response missing the delegated contract field",
      "infra",
      body.ledgerId
    );
  }
  if (
    body.escalate === true ||
    body.outcome !== "pass" ||
    typeof body.output !== "string" ||
    !body.output
  ) {
    // The local model ran but its output was unusable — verifier fail/error,
    // empty output, or an outcome the contract doesn't call a pass. We always
    // send a verifier, so anything but an explicit "pass" is a failed attempt.
    throw new M5TriageError(
      `local triage output unusable (outcome=${body.outcome ?? "missing"}): ${
        body.decisionReason ?? "no reason given"
      }`,
      "parse",
      body.ledgerId
    );
  }

  let decision: TriageDecision;
  try {
    decision = parseTriageDecision(body.output, { lenient: false });
  } catch {
    // Deliberately content-free: the parse error embeds the raw model output,
    // which can echo the user's message — that must never reach persisted
    // attempt records (Munin) or log lines.
    throw new M5TriageError(
      "local triage output failed strict parse (not a valid triage decision)",
      "parse",
      body.ledgerId
    );
  }

  return {
    decision,
    promptTokens: body.metrics?.promptTokens ?? 0,
    completionTokens: body.metrics?.completionTokens ?? 0,
    ledgerId: body.ledgerId,
  };
}

export async function triage(
  message: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
  muninContext: string,
  replyContext?: TrackedMessage | null,
  images?: Array<{ base64: string; mediaType: string }>,
  deps?: { fetchImpl?: typeof fetch }
): Promise<TriageResult> {
  const systemContent = buildSystemContent(muninContext, replyContext);
  const attempts: TriageAttempt[] = [];

  // M5 gateway path (issue #31): text-only triage classification. Image triage
  // stays on Anthropic — vision on the local /delegate lane is untested, and a
  // guaranteed-failing attempt would just add a timeout to every screenshot.
  if (config.triageUrl && !images?.length) {
    const startedAt = Date.now();
    try {
      const m5 = await triageViaM5(
        message,
        conversationHistory,
        systemContent,
        deps?.fetchImpl ?? fetch
      );
      const latencyMs = Date.now() - startedAt;
      attempts.push({
        backend: "m5",
        model: config.triageModel,
        outcome: "pass",
        latencyMs,
        ...(m5.ledgerId ? { ledgerId: m5.ledgerId } : {}),
      });
      const meta: TriageMeta = {
        model: config.triageModel,
        backend: "m5",
        fallback: false,
        latencyMs,
        inputTokens: m5.promptTokens,
        outputTokens: m5.completionTokens,
        attempts,
      };
      return { ...m5.decision, meta };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const errorClass =
        err instanceof M5TriageError ? err.errorClass : "infra";
      const errorMessage = err instanceof Error ? err.message : String(err);
      attempts.push({
        backend: "m5",
        model: config.triageModel,
        outcome: "error",
        errorClass,
        latencyMs,
        error: errorMessage,
        ...(err instanceof M5TriageError && err.ledgerId
          ? { ledgerId: err.ledgerId }
          : {}),
      });
      // Fallback must be VISIBLE (issue #31): a degraded path never looks
      // identical to a healthy one. Descriptor counter comes via TriageStats.
      console.warn(
        `⚠️  M5 triage gateway failed (${errorClass}: ${errorMessage}) — ` +
          `falling back to Anthropic (${config.conciergeModel})`
      );
    }
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  // Build the final user message
  const userContent: Anthropic.ContentBlockParam[] = [];

  // Add images first (so the model "sees" them before the text)
  if (images?.length) {
    for (const img of images) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: img.base64,
        },
      });
    }
  }

  // Add the text (caption or empty prompt)
  userContent.push({ type: "text", text: message || "What's in this image?" });

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: images?.length ? userContent : message },
  ];

  const startedAt = Date.now();
  const response = await client.messages.create({
    model: config.conciergeModel,
    max_tokens: 1024,
    system: systemContent,
    messages,
  });
  const latencyMs = Date.now() - startedAt;

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const decision = parseTriageDecision(text, { lenient: true });

  attempts.push({
    backend: "anthropic",
    model: config.conciergeModel,
    outcome: "pass",
    latencyMs,
  });
  const meta: TriageMeta = {
    model: config.conciergeModel,
    backend: "anthropic",
    // fallback=true only when an M5 attempt preceded this (degraded path);
    // feature-off and image triage are healthy Anthropic-served decisions.
    fallback: attempts.length > 1,
    latencyMs,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    attempts,
  };

  return { ...decision, meta };
}

/**
 * Summarize a task result body using Haiku with the Ratatoskr soul voice.
 * Returns a terse 2-3 sentence summary suitable for Telegram.
 */
export async function summarizeResult(body: string): Promise<string> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.conciergeModel,
    max_tokens: 512,
    system: `${RATATOSKR_SOUL}

Summarize this task result in 2-3 terse sentences. Lead with what was done, not the process. If there are code changes, mention what files changed and why. Skip file-by-file breakdowns, test counts, and implementation details. No bullet points, no headers, no markdown. Plain text only.`,
    messages: [{ role: "user", content: body }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return text.trim() || body;
}

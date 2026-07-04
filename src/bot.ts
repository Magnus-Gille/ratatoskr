import { Bot, Context } from "grammy";
import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { gatherContext, triage, summarizeResult } from "./concierge.js";
import type { TriageAction, TriageMeta } from "./concierge.js";
import { submitTask } from "./task-writer.js";
import { formatResultWithSummary } from "./telegram-util.js";
import { MessageAggregator } from "./message-aggregator.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { MessageTracker } from "./message-tracker.js";
import type { TrackedMessage } from "./message-tracker.js";
import { downloadPhoto, downloadFile } from "./telegram-file.js";
import { createTranscriber, checkVoiceLimits } from "./transcribe.js";
import type { TriageStats } from "./triage-stats.js";

const TRIAGE_LOG_NAMESPACE = "ratatoskr/triage";

/**
 * Build the Munin competence-evidence log entry for a triage decision
 * (issue #27) — action taken, model, latency, and token usage.
 */
export function buildTriageLogEntry(
  action: TriageAction,
  meta: TriageMeta
): { namespace: string; content: string; tags: string[] } {
  return {
    namespace: TRIAGE_LOG_NAMESPACE,
    content: JSON.stringify({
      action,
      model: meta.model,
      latencyMs: meta.latencyMs,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      timestamp: Date.now(),
    }),
    tags: ["triage", `action:${action}`, `instance:${config.instanceId}`],
  };
}

/**
 * Record triage competence evidence (issue #27): tally into TriageStats
 * (synchronous, for /heimdall.json) and fire-and-forget log to Munin. Split
 * out from handleTriageResult so this fire-and-forget contract — never block
 * or fail message handling — is independently testable and can't silently
 * regress into an awaited call.
 */
export function recordTriageEvidence(
  munin: MuninClient,
  triageStats: TriageStats,
  result: Awaited<ReturnType<typeof triage>>
): void {
  triageStats.record(result.action, result.meta);
  const logEntry = buildTriageLogEntry(result.action, result.meta);
  munin
    .log(logEntry.namespace, logEntry.content, logEntry.tags)
    .catch((err) => {
      console.error("Failed to log triage decision:", err);
    });
}

/**
 * Build the one-time "picked up" ack callback for a task. Replies on the same
 * chat as the originating context. A send failure is allowed to propagate so the
 * poller can retry on a later poll and only persist its "acked" marker once the
 * ack is actually delivered (see ResultPoller.ackPickup).
 */
function makePickupAck(ctx: Context): (message: string) => Promise<void> {
  return async (message: string) => {
    await ctx.reply(message);
  };
}

/**
 * Build a reply context object from Telegram's reply_to_message and the
 * in-memory tracker result (either of which may be absent).
 *
 * Telegram delivers the text of the replied-to message for free in
 * `reply_to_message.text` / `reply_to_message.caption`, so we don't need the
 * tracker for untracked alerts. This function merges both sources with
 * Telegram's text taking precedence.
 *
 * Returns null when there is no usable reply information.
 */
export function buildReplyContext(
  repliedTo: { message_id: number; text?: string; caption?: string } | undefined | null,
  tracked: TrackedMessage | null
): TrackedMessage | null {
  const repliedText = repliedTo?.text ?? repliedTo?.caption;
  if (!repliedTo || (!repliedText && !tracked)) return null;

  const replyToText = repliedText?.slice(0, 1000);

  if (tracked) {
    return { ...tracked, replyToText };
  }

  // Untracked message (e.g. proactive alert) — synthesize a minimal object
  return { type: "status", timestamp: Date.now(), replyToText };
}

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

interface ConversationState {
  messages: ConversationEntry[];
  lastActivity: number;
}

const CONVERSATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY = 5;
// Upper bound on a voice transcript before it's echoed / triaged / persisted, so
// a long note can't bloat the concierge prompt or Munin conversation state.
const MAX_TRANSCRIPT_CHARS = 8000;
const CONVERSATION_NAMESPACE = "ratatoskr/conversations";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

function conciergeErrorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Transcription errors must classify before the generic JSON branch, else an
  // invalid-JSON transcription response reads as "Haiku returned gibberish".
  if (/transcri/i.test(msg)) return "transcription failed — check the voice endpoint";
  if (/rate.?limit|429/i.test(msg)) return "API rate limit, wait a moment";
  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(msg)) return "API timed out";
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) return "can't reach API";
  if (/Munin/i.test(msg)) return "Munin unreachable";
  if (/JSON|parse|Unexpected token/i.test(msg)) return "Haiku returned gibberish";
  if (/auth|401|403/i.test(msg)) return "API auth error";
  if (/5\d{2}|server error/i.test(msg)) return "API server error";
  return msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
}

async function loadConversation(
  munin: MuninClient,
  chatId: string
): Promise<ConversationState | null> {
  try {
    const entry = await munin.read(CONVERSATION_NAMESPACE, chatId);
    if (!entry) return null;
    const state: ConversationState = JSON.parse(entry.content);
    if (Date.now() - state.lastActivity > CONVERSATION_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

async function saveConversation(
  munin: MuninClient,
  chatId: string,
  state: ConversationState
): Promise<void> {
  try {
    await munin.write(
      CONVERSATION_NAMESPACE,
      chatId,
      JSON.stringify(state),
      ["conversation", `instance:${config.instanceId}`]
    );
  } catch (err) {
    console.error(`Failed to persist conversation for ${chatId}:`, err);
  }
}

async function deleteConversation(
  munin: MuninClient,
  chatId: string
): Promise<void> {
  try {
    await munin.write(CONVERSATION_NAMESPACE, chatId, JSON.stringify({ messages: [], lastActivity: 0 }), ["expired"]);
  } catch {
    // Best-effort cleanup
  }
}

export function createBot(
  munin: MuninClient,
  poller: ResultPoller,
  triageStats: TriageStats
): Bot {
  const bot = new Bot(config.telegramBotToken);
  // In-memory cache, backed by Munin persistence
  const conversations = new Map<string, ConversationState>();
  const messageTracker = new MessageTracker();
  const pendingReplyContext = new Map<string, TrackedMessage>();

  // Per-user concierge rate limit (issue #3): cap Haiku triage calls per chat so
  // a message burst can't fan out into unbounded API calls. A second 1-per-window
  // limiter throttles the "slow down" notice so we don't spam it on every reject.
  const conciergeLimiter = new SlidingWindowRateLimiter(
    config.conciergeRateLimit,
    config.conciergeRateWindowMs
  );
  const rateLimitNotice = new SlidingWindowRateLimiter(
    1,
    config.conciergeRateWindowMs
  );

  /**
   * Gate a concierge (triage) call by the per-user rate limit. Returns true when
   * allowed; when over the limit, replies a throttled "slow down" notice (at most
   * once per window) and returns false so the caller skips the triage.
   */
  async function withinConciergeRate(
    ctx: Context,
    chatId: string
  ): Promise<boolean> {
    if (conciergeLimiter.tryAcquire(chatId)) return true;
    if (rateLimitNotice.tryAcquire(chatId)) {
      try {
        await ctx.reply("Too many at once — give me a sec, then resend.");
      } catch (err) {
        console.error(`Failed to send rate-limit notice to ${chatId}:`, err);
      }
    }
    return false;
  }

  // Voice transcription (issue #1) — only enabled when a local Whisper endpoint
  // is configured; otherwise voice messages are politely declined.
  const transcriber = config.transcribeUrl
    ? createTranscriber({
        url: config.transcribeUrl,
        model: config.transcribeModel,
        token: config.transcribeToken || undefined,
      })
    : null;

  function isAllowed(ctx: Context): boolean {
    const userId = ctx.from?.id?.toString();
    if (!userId || !config.allowedUsers.includes(userId)) return false;
    if (ctx.chat?.type !== "private") return false;
    return true;
  }

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  async function getConversation(chatId: string): Promise<ConversationEntry[]> {
    // Check in-memory cache first
    const cached = conversations.get(chatId);
    if (cached) {
      if (Date.now() - cached.lastActivity > CONVERSATION_TTL_MS) {
        conversations.delete(chatId);
        return [];
      }
      return cached.messages;
    }
    // Fall back to Munin
    const stored = await loadConversation(munin, chatId);
    if (stored?.messages) {
      conversations.set(chatId, stored);
      return stored.messages;
    }
    return [];
  }

  async function addToConversation(
    chatId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    let state = conversations.get(chatId);
    if (!state || Date.now() - state.lastActivity > CONVERSATION_TTL_MS) {
      state = { messages: [], lastActivity: Date.now() };
    }
    state.messages.push({ role, content });
    if (state.messages.length > MAX_HISTORY) {
      state.messages = state.messages.slice(-MAX_HISTORY);
    }
    state.lastActivity = Date.now();
    conversations.set(chatId, state);
    await saveConversation(munin, chatId, state);
  }

  async function clearConversation(chatId: string): Promise<void> {
    conversations.delete(chatId);
    await deleteConversation(munin, chatId);
  }

  // Shared concierge-result handler for the text, photo, and voice paths: submit
  // + ack + poll (ready), record + reply (clarify), or reply (answer).
  // `userHistoryText` is stored as the user turn when clarifying.
  async function handleTriageResult(
    ctx: Context,
    chatId: string,
    result: Awaited<ReturnType<typeof triage>>,
    userHistoryText: string
  ): Promise<void> {
    // Competence evidence (issue #27), fire-and-forget — see recordTriageEvidence.
    recordTriageEvidence(munin, triageStats, result);

    switch (result.action) {
      case "ready": {
        await clearConversation(chatId);
        const taskId = await submitTask({ ...result.task, chatId }, munin);
        const duration = formatDuration(result.task.timeout);
        const ackSent = await ctx.reply(
          `Got it, submitting to ${result.task.context}. ~${duration}.`
        );
        messageTracker.track(ackSent.message_id, { type: "ack", taskId });
        poller.startPolling(
          taskId,
          async (pollResult) => {
            try {
              const resultText = await formatResultWithSummary(
                pollResult,
                taskId,
                summarizeResult
              );
              const sent = await ctx.reply(resultText);
              messageTracker.track(sent.message_id, {
                type: "result",
                taskId,
                snippet: resultText.slice(0, 200),
              });
            } catch (err) {
              console.error(`Failed to deliver result for ${taskId}:`, err);
            }
          },
          makePickupAck(ctx)
        );
        break;
      }
      case "clarify": {
        await addToConversation(chatId, "user", userHistoryText);
        await addToConversation(chatId, "assistant", result.question);
        const sent = await ctx.reply(result.question);
        messageTracker.track(sent.message_id, {
          type: "clarify",
          snippet: result.question.slice(0, 200),
        });
        break;
      }
      case "answer": {
        await clearConversation(chatId);
        const sent = await ctx.reply(result.reply);
        messageTracker.track(sent.message_id, {
          type: "answer",
          snippet: result.reply.slice(0, 200),
        });
        break;
      }
    }
  }

  // --- Commands ---

  bot.command("help", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.reply(
      `/status — Show recent tasks
/cancel <id> — Cancel a pending task
/raw <text> — Submit task verbatim (scratch context)
/repo <name> <text> — Submit task to a repo
/help — This message

Or just send a message and the concierge will triage it.`
    );
  });

  bot.command("status", async (ctx) => {
    if (!isAllowed(ctx)) return;
    try {
      const results = await munin.query({
        query: "task status",
        namespace: "tasks/",
        limit: 10,
      });
      if (results.results.length === 0) {
        await ctx.reply("No recent tasks.");
        return;
      }
      const lines = results.results.map((r) => {
        const tags = r.tags.join(", ");
        const name = r.namespace.replace("tasks/", "");
        return `• ${name} [${tags}]`;
      });
      await ctx.reply(lines.join("\n"));
    } catch (err) {
      console.error("Status command error:", err);
      await ctx.reply("Error checking status. Check logs.");
    }
  });

  bot.command("cancel", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const taskId = ctx.match?.trim();
    if (!taskId) {
      await ctx.reply("Usage: /cancel <task-id>");
      return;
    }
    try {
      const entry = await munin.read(`tasks/${taskId}`, "status");
      if (!entry) {
        await ctx.reply(`Task ${taskId} not found.`);
        return;
      }
      if (entry.tags.includes("running")) {
        await ctx.reply(`Task ${taskId} is already running — can't cancel.`);
        return;
      }
      if (
        entry.tags.includes("completed") ||
        entry.tags.includes("failed")
      ) {
        await ctx.reply(`Task ${taskId} already finished.`);
        return;
      }
      await munin.write(
        `tasks/${taskId}`,
        "status",
        entry.content,
        ["cancelled"]
      );
      poller.stopPolling(taskId);
      await ctx.reply(`Cancelled ${taskId}.`);
    } catch (err) {
      console.error("Cancel command error:", err);
      await ctx.reply("Error cancelling task. Check logs.");
    }
  });

  bot.command("raw", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply("Usage: /raw <prompt text>");
      return;
    }
    try {
      const taskId = await submitTask(
        {
          title: text.slice(0, 30),
          prompt: text,
          context: "scratch",
          timeout: 600,
          chatId: ctx.chat.id.toString(),
        },
        munin
      );
      const ackRaw = await ctx.reply(`Submitted to scratch. Task: ${taskId}`);
      messageTracker.track(ackRaw.message_id, { type: "ack", taskId });
      poller.startPolling(
        taskId,
        async (result) => {
          try {
            const resultText = await formatResultWithSummary(result, taskId, summarizeResult);
            const sent = await ctx.reply(resultText);
            messageTracker.track(sent.message_id, {
              type: "result",
              taskId,
              snippet: resultText.slice(0, 200),
            });
          } catch (err) {
            console.error(`Failed to deliver result for ${taskId}:`, err);
          }
        },
        makePickupAck(ctx)
      );
    } catch (err) {
      console.error("Raw command error:", err);
      await ctx.reply("Error submitting task. Check logs.");
    }
  });

  bot.command("repo", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const match = ctx.match?.trim();
    if (!match) {
      await ctx.reply("Usage: /repo <name> <prompt text>");
      return;
    }
    const spaceIdx = match.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Usage: /repo <name> <prompt text>");
      return;
    }
    const repoName = match.slice(0, spaceIdx);
    const text = match.slice(spaceIdx + 1).trim();
    if (!text) {
      await ctx.reply("Usage: /repo <name> <prompt text>");
      return;
    }
    try {
      const taskId = await submitTask(
        {
          title: text.slice(0, 30),
          prompt: text,
          context: `repo:${repoName}`,
          timeout: 600,
          chatId: ctx.chat.id.toString(),
        },
        munin
      );
      const ackRepo = await ctx.reply(`Submitted to repo:${repoName}. Task: ${taskId}`);
      messageTracker.track(ackRepo.message_id, { type: "ack", taskId });
      poller.startPolling(
        taskId,
        async (result) => {
          try {
            const resultText = await formatResultWithSummary(result, taskId, summarizeResult);
            const sent = await ctx.reply(resultText);
            messageTracker.track(sent.message_id, {
              type: "result",
              taskId,
              snippet: resultText.slice(0, 200),
            });
          } catch (err) {
            console.error(`Failed to deliver result for ${taskId}:`, err);
          }
        },
        makePickupAck(ctx)
      );
    } catch (err) {
      console.error("Repo command error:", err);
      await ctx.reply("Error submitting task. Check logs.");
    }
  });

  // --- Regular messages → concierge (with debounce aggregation) ---
  //
  // Telegram splits messages longer than 4096 characters into sequential
  // fragments.  The aggregator collects fragments within a short window and
  // joins them before the concierge sees the text, so long messages are never
  // accidentally split into separate tasks.

  // Keep a map from chatId to the most-recent grammy Context so that the
  // aggregator callback can call ctx.reply on the right chat.
  const latestCtx = new Map<string, Context>();

  const AGGREGATION_WINDOW_MS = 2500;

  const aggregator = new MessageAggregator(
    AGGREGATION_WINDOW_MS,
    (chatId, message) => {
      const ctx = latestCtx.get(chatId);
      if (!ctx) return;

      (async () => {
        try {
          // Consume the pending reply context up front so a rate-limited (or
          // failed) turn discards its own context instead of leaking it onto the
          // next, unrelated message.
          const replyCtx = pendingReplyContext.get(chatId) ?? null;
          pendingReplyContext.delete(chatId);
          if (!(await withinConciergeRate(ctx, chatId))) return;
          const history = await getConversation(chatId);
          const muninContext = await gatherContext(munin);
          const result = await triage(message, history, muninContext, replyCtx);
          await handleTriageResult(ctx, chatId, result, message);
        } catch (err) {
          console.error("Concierge error:", err);
          const reason = conciergeErrorReason(err);
          await ctx.reply(
            `Concierge error: ${reason}. Try /raw <prompt> to bypass.`
          );
        }
      })();
    }
  );

  bot.on("message:photo", async (ctx) => {
    if (!isAllowed(ctx)) return;

    const chatId = ctx.chat.id.toString();
    latestCtx.set(chatId, ctx);

    // Rate-limit before downloading the photo or calling Haiku (issue #3).
    if (!(await withinConciergeRate(ctx, chatId))) return;

    // Get the largest photo (last in array = highest resolution)
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    try {
      const image = await downloadPhoto(ctx.api, largest.file_id);
      const caption = ctx.message.caption || "";
      const history = await getConversation(chatId);
      const muninContext = await gatherContext(munin);

      // Check if this is a reply to a previous message.
      // Merge Telegram's reply text with the tracker so untracked alerts work.
      const repliedToPhoto = ctx.message.reply_to_message;
      const trackedPhoto = repliedToPhoto ? messageTracker.lookup(repliedToPhoto.message_id) : null;
      const replyCtx = buildReplyContext(repliedToPhoto, trackedPhoto);

      const result = await triage(
        caption,
        history,
        muninContext,
        replyCtx,
        [image]
      );

      // Store in conversation history with placeholder (no base64)
      const historyEntry = caption
        ? `[sent a photo with caption: "${caption}"]`
        : "[sent a photo]";

      await handleTriageResult(ctx, chatId, result, historyEntry);
    } catch (err) {
      console.error("Photo handler error:", err);
      const reason = conciergeErrorReason(err);
      await ctx.reply(`Couldn't process that image: ${reason}. Try /raw <prompt>.`);
    }
  });

  bot.on("message:voice", async (ctx) => {
    if (!isAllowed(ctx)) return;

    const chatId = ctx.chat.id.toString();
    latestCtx.set(chatId, ctx);

    if (!transcriber) {
      await ctx.reply(
        "Voice messages aren't wired up yet — send text or use /raw."
      );
      return;
    }

    // Rate-limit before downloading audio or transcribing (issue #3).
    if (!(await withinConciergeRate(ctx, chatId))) return;

    const voice = ctx.message.voice;
    // Reject oversized/overlong notes up front (issue #1 hardening) — using the
    // Telegram metadata, before any download or transcription.
    const limitReason = checkVoiceLimits(
      voice.duration,
      voice.file_size,
      config.voiceMaxDurationS
    );
    if (limitReason) {
      await ctx.reply(limitReason);
      return;
    }

    try {
      const audio = await downloadFile(
        ctx.api,
        voice.file_id,
        voice.mime_type ?? "audio/ogg"
      );
      const rawTranscript = await transcriber(
        audio.buffer,
        audio.filename,
        audio.mimeType
      );
      // Bound the transcript before it's echoed, triaged, or persisted to Munin.
      const transcript = rawTranscript.slice(0, MAX_TRANSCRIPT_CHARS);

      // Transcription is imperfect — show what was heard so a misheard task is
      // obvious to the user. Cap the echo so a long note can't blow Telegram's
      // 4096-char limit.
      const heard =
        transcript.length > 3500 ? transcript.slice(0, 3500) + "…" : transcript;
      await ctx.reply(`Heard: "${heard}"`);

      const repliedTo = ctx.message.reply_to_message;
      const tracked = repliedTo
        ? messageTracker.lookup(repliedTo.message_id)
        : null;
      const replyCtx = buildReplyContext(repliedTo, tracked);

      const history = await getConversation(chatId);
      const muninContext = await gatherContext(munin);
      const result = await triage(transcript, history, muninContext, replyCtx);

      await handleTriageResult(ctx, chatId, result, `[voice] ${transcript}`);
    } catch (err) {
      console.error("Voice handler error:", err);
      const reason = conciergeErrorReason(err);
      await ctx.reply(
        `Couldn't process that voice message: ${reason}. Try text or /raw.`
      );
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!isAllowed(ctx)) return;

    const chatId = ctx.chat.id.toString();
    // Always keep the freshest ctx so replies go to the right update.
    latestCtx.set(chatId, ctx);

    // Check if this message is a reply to one of our messages.
    // We merge Telegram's reply_to_message text (always present when replying)
    // with the tracker result so that untracked proactive alerts are handled.
    const repliedTo = ctx.message.reply_to_message;
    const tracked = repliedTo ? messageTracker.lookup(repliedTo.message_id) : null;
    const replyContext = buildReplyContext(repliedTo, tracked);
    if (replyContext) {
      pendingReplyContext.set(chatId, replyContext);
    }

    aggregator.push(chatId, ctx.message.text);
  });

  return bot;
}

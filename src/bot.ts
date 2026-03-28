import { Bot, Context } from "grammy";
import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { gatherContext, triage } from "./concierge.js";
import { submitTask } from "./task-writer.js";
import { truncateResult } from "./telegram-util.js";

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
const CONVERSATION_NAMESPACE = "ratatoskr/conversations";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
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
  poller: ResultPoller
): Bot {
  const bot = new Bot(config.telegramBotToken);
  // In-memory cache, backed by Munin persistence
  const conversations = new Map<string, ConversationState>();

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
      await ctx.reply(`Submitted to scratch. Task: ${taskId}`);
      poller.startPolling(taskId, async (result) => {
        try {
          await ctx.reply(truncateResult(result, taskId));
        } catch (err) {
          console.error(`Failed to deliver result for ${taskId}:`, err);
        }
      });
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
      await ctx.reply(`Submitted to repo:${repoName}. Task: ${taskId}`);
      poller.startPolling(taskId, async (result) => {
        try {
          await ctx.reply(truncateResult(result, taskId));
        } catch (err) {
          console.error(`Failed to deliver result for ${taskId}:`, err);
        }
      });
    } catch (err) {
      console.error("Repo command error:", err);
      await ctx.reply("Error submitting task. Check logs.");
    }
  });

  // --- Regular messages → concierge ---

  bot.on("message:text", async (ctx) => {
    if (!isAllowed(ctx)) return;

    const chatId = ctx.chat.id.toString();
    const message = ctx.message.text;

    try {
      const history = await getConversation(chatId);
      const muninContext = await gatherContext(munin);
      const result = await triage(message, history, muninContext);

      switch (result.action) {
        case "ready": {
          await clearConversation(chatId);
          const taskId = await submitTask(
            {
              ...result.task,
              chatId,
            },
            munin
          );
          const duration = formatDuration(result.task.timeout);
          await ctx.reply(
            `Got it, submitting to ${result.task.context}. ~${duration}.`
          );
          poller.startPolling(taskId, async (pollResult) => {
            try {
              await ctx.reply(truncateResult(pollResult, taskId));
            } catch (err) {
              console.error(
                `Failed to deliver result for ${taskId}:`,
                err
              );
            }
          });
          break;
        }
        case "clarify": {
          await addToConversation(chatId, "user", message);
          await addToConversation(chatId, "assistant", result.question);
          await ctx.reply(result.question);
          break;
        }
        case "answer": {
          await clearConversation(chatId);
          await ctx.reply(result.reply);
          break;
        }
      }
    } catch (err) {
      console.error("Concierge error:", err);
      await ctx.reply(
        "Something went wrong with the concierge. Try /raw <prompt> to bypass."
      );
    }
  });

  return bot;
}

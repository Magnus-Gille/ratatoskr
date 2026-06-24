import { Api } from "grammy";
import { config } from "./config.js";
import { MuninClient, MuninQueryResult } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { formatResultWithSummary, STATUS_MESSAGES } from "./telegram-util.js";
import { summarizeResult } from "./concierge.js";

/**
 * Parse chatId from a task's metadata header (before ### Prompt).
 * Returns null if the task wasn't submitted by this instance or has no Reply-to.
 */
export function parseTaskMetadata(
  content: string,
  instanceId: string
): { chatId: number } | null {
  const header = content.split("### Prompt")[0];
  if (!header.includes("**Submitted by:** ratatoskr")) return null;

  const chatIdMatch = header.match(/\*\*Reply-to:\*\* telegram:(\d+)/);
  if (!chatIdMatch) return null;

  return { chatId: parseInt(chatIdMatch[1]) };
}

function makeDeliveryCallback(
  botApi: Api,
  taskId: string,
  chatId: number
): (result: string) => Promise<void> {
  return async (result: string) => {
    try {
      await botApi.sendMessage(chatId, await formatResultWithSummary(result, taskId, summarizeResult));
    } catch (err) {
      console.error(
        `Failed to deliver recovered result for ${taskId}:`,
        err
      );
    }
  };
}

function makePickupCallback(
  botApi: Api,
  taskId: string,
  chatId: number
): (message: string) => Promise<void> {
  return async (message: string) => {
    try {
      await botApi.sendMessage(chatId, message);
    } catch (err) {
      console.error(`Failed to deliver recovered pickup ack for ${taskId}:`, err);
    }
  };
}

export async function recoverActivePolls(
  munin: MuninClient,
  poller: ResultPoller,
  botApi: Api
): Promise<number> {
  const instanceTag = `instance:${config.instanceId}`;

  // Phase 1: Recover pending/running tasks (resume polling)
  const [pending, running] = await Promise.all([
    munin.query({
      query: "ratatoskr",
      namespace: "tasks/",
      tags: ["pending", instanceTag],
      entry_type: "state",
      limit: 50,
    }),
    munin.query({
      query: "ratatoskr",
      namespace: "tasks/",
      tags: ["running", instanceTag],
      entry_type: "state",
      limit: 50,
    }),
  ]);

  const activeTasks = [...pending.results, ...running.results];
  let recovered = 0;

  for (const task of activeTasks) {
    const entry = await munin.read(task.namespace, "status");
    if (!entry) continue;

    const meta = parseTaskMetadata(entry.content, config.instanceId);
    if (!meta) continue;

    const taskId = task.namespace.replace(/^tasks\//, "");
    poller.startPolling(
      taskId,
      makeDeliveryCallback(botApi, taskId, meta.chatId),
      makePickupCallback(botApi, taskId, meta.chatId)
    );
    recovered++;
  }

  // Phase 2: Recover completed-but-undelivered tasks
  const [completed, failed] = await Promise.all([
    munin.query({
      query: "ratatoskr",
      namespace: "tasks/",
      tags: ["completed", instanceTag],
      entry_type: "state",
      limit: 50,
    }),
    munin.query({
      query: "ratatoskr",
      namespace: "tasks/",
      tags: ["failed", instanceTag],
      entry_type: "state",
      limit: 50,
    }),
  ]);

  const terminalTasks = [...completed.results, ...failed.results];

  for (const task of terminalTasks) {
    const taskId = task.namespace.replace(/^tasks\//, "");

    // Check if already delivered
    try {
      const delivery = await munin.read(task.namespace, "delivery");
      if (delivery) continue; // Already delivered
    } catch {
      // No delivery record — needs recovery
    }

    const entry = await munin.read(task.namespace, "status");
    if (!entry) continue;

    const meta = parseTaskMetadata(entry.content, config.instanceId);
    if (!meta) continue;

    // Read result and deliver directly (no polling needed)
    let resultText = task.tags.includes("completed")
      ? STATUS_MESSAGES.completedFallback
      : STATUS_MESSAGES.failedFallback;
    try {
      const result = await munin.read(task.namespace, "result");
      if (result) resultText = result.content;
    } catch {
      // Use default message
    }

    try {
      await botApi.sendMessage(
        meta.chatId,
        await formatResultWithSummary(resultText, taskId, summarizeResult)
      );
      // Mark as delivered
      await munin.write(
        task.namespace,
        "delivery",
        `Delivered to Telegram at ${new Date().toISOString()} (recovered)`,
        ["delivered", `instance:${config.instanceId}`]
      );
      recovered++;
    } catch (err) {
      console.error(
        `Failed to deliver recovered completed result for ${taskId}:`,
        err
      );
    }
  }

  return recovered;
}

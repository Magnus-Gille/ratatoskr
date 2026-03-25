import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";

export class ResultPoller {
  private activePolls: Map<string, NodeJS.Timeout> = new Map();
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  private munin: MuninClient;
  private stopped = false;

  constructor(munin: MuninClient) {
    this.munin = munin;
  }

  startPolling(
    taskId: string,
    onComplete: (result: string) => Promise<void> | void
  ): void {
    // Don't double-poll
    if (this.activePolls.has(taskId)) return;

    const poll = async () => {
      if (this.stopped) return;
      try {
        const entry = await this.munin.read(`tasks/${taskId}`, "status");
        if (!entry || this.stopped) return;

        const tags = entry.tags || [];
        if (
          tags.includes("completed") ||
          tags.includes("failed") ||
          tags.includes("cancelled")
        ) {
          this.stopPolling(taskId);

          if (tags.includes("cancelled")) {
            await onComplete(`Task ${taskId} was cancelled.`);
            return;
          }

          let resultText = `Task ${tags.includes("completed") ? "completed" : "failed"}.`;
          try {
            const result = await this.munin.read(
              `tasks/${taskId}`,
              "result"
            );
            if (result) {
              resultText = result.content;
            }
          } catch {
            // Could not read result — use default message
          }

          await onComplete(resultText);

          // Mark as delivered so recovery won't re-deliver
          try {
            await this.munin.write(
              `tasks/${taskId}`,
              "delivery",
              `Delivered to Telegram at ${new Date().toISOString()}`,
              ["delivered", `instance:${config.instanceId}`]
            );
          } catch {
            // Best-effort — delivery already happened
          }
        }
      } catch (err) {
        console.error(`Poll error for ${taskId}:`, err);
      }
    };

    const interval = setInterval(poll, config.pollIntervalMs);
    this.activePolls.set(taskId, interval);

    // Set max duration timeout
    const timeout = setTimeout(() => {
      this.stopPolling(taskId);
      void onComplete(
        `Task ${taskId} timed out after ${Math.round(config.maxPollDurationMs / 60000)} minutes of polling. Check Munin for status.`
      );
    }, config.maxPollDurationMs);
    this.timeouts.set(taskId, timeout);

    // Do an immediate first check
    poll();
  }

  stopPolling(taskId: string): void {
    const interval = this.activePolls.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.activePolls.delete(taskId);
    }
    const timeout = this.timeouts.get(taskId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(taskId);
    }
  }

  stopAll(): void {
    this.stopped = true;
    for (const taskId of this.activePolls.keys()) {
      this.stopPolling(taskId);
    }
  }

  get activePollCount(): number {
    return this.activePolls.size;
  }
}

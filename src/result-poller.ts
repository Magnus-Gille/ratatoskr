import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { STATUS_MESSAGES } from "./telegram-util.js";

export class ResultPoller {
  private activePolls: Map<string, NodeJS.Timeout> = new Map();
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  /** Tasks whose "picked up" ack has been handled in this process (re-entry guard). */
  private pickupAcked: Set<string> = new Set();
  private munin: MuninClient;
  private stopped = false;

  constructor(munin: MuninClient) {
    this.munin = munin;
  }

  startPolling(
    taskId: string,
    onComplete: (result: string) => Promise<void> | void,
    onPickup?: (message: string) => Promise<void> | void
  ): void {
    // Don't double-poll
    if (this.activePolls.has(taskId)) return;

    const poll = async () => {
      if (this.stopped) return;
      try {
        const entry = await this.munin.read(`tasks/${taskId}`, "status");
        if (!entry || this.stopped) return;

        const tags = entry.tags || [];
        const isTerminal =
          tags.includes("completed") ||
          tags.includes("failed") ||
          tags.includes("cancelled");

        if (!isTerminal) {
          // Intermediate "picked up" ack on the first observed running
          // transition. Guarded by an in-memory set (re-entry within this
          // process) and a persisted Munin marker (no re-ack across a restart).
          if (
            onPickup &&
            tags.includes("running") &&
            !this.pickupAcked.has(taskId)
          ) {
            this.pickupAcked.add(taskId);
            try {
              await this.ackPickup(taskId, onPickup);
            } catch (err) {
              console.error(`Pickup ack error for ${taskId}:`, err);
            }
          }
          return;
        }

        // Terminal — deliver the result and stop polling.
        this.stopPolling(taskId);

        if (tags.includes("cancelled")) {
          await onComplete(STATUS_MESSAGES.cancelled(taskId));
          return;
        }

        let resultText = tags.includes("completed")
          ? STATUS_MESSAGES.completedFallback
          : STATUS_MESSAGES.failedFallback;
        try {
          const result = await this.munin.read(`tasks/${taskId}`, "result");
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
        STATUS_MESSAGES.pollTimeout(taskId, Math.round(config.maxPollDurationMs / 60000))
      );
    }, config.maxPollDurationMs);
    this.timeouts.set(taskId, timeout);

    // Do an immediate first check
    poll();
  }

  /**
   * Deliver the one-time "picked up" ack for a task. De-duped across process
   * restarts by a persisted Munin marker (mirrors the "delivery" marker), so a
   * task already acked before a restart is not re-announced on recovery.
   */
  private async ackPickup(
    taskId: string,
    onPickup: (message: string) => Promise<void> | void
  ): Promise<void> {
    // Skip if a prior process already acked this task (persisted marker).
    try {
      const marker = await this.munin.read(`tasks/${taskId}`, "pickup");
      if (marker) return;
    } catch {
      // No marker / read failed — treat as not yet acked.
    }

    await onPickup(STATUS_MESSAGES.pickedUp(taskId));

    // Persist the marker so a restart + recovery won't re-announce.
    try {
      await this.munin.write(
        `tasks/${taskId}`,
        "pickup",
        `Picked up, acked to Telegram at ${new Date().toISOString()}`,
        ["picked-up", `instance:${config.instanceId}`]
      );
    } catch {
      // Best-effort marker — a re-ack on restart is acceptable.
    }
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
    // Bound the pickup-ack guard to currently-polled tasks (avoids unbounded
    // growth over a long-lived process).
    this.pickupAcked.delete(taskId);
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

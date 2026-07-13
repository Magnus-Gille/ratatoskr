import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { STATUS_MESSAGES } from "./telegram-util.js";

export class ResultPoller {
  private activePolls: Map<string, NodeJS.Timeout> = new Map();
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  /** Tasks whose "picked up" ack has been handled in this process (re-entry guard). */
  private pickupAcked: Set<string> = new Set();
  /** Tasks with a poll currently in flight — serializes overlapping interval ticks. */
  private polling: Set<string> = new Set();
  /**
   * Tasks whose Telegram result send succeeded but whose Munin delivery marker
   * has not necessarily persisted yet. This prevents same-process duplicates
   * while marker writes are retried.
   *
   * Delivery is deliberately at-least-once: if the process dies after Telegram
   * accepts a message but before Munin records the marker, startup recovery can
   * send it again. Telegram has no idempotency key, so that rare duplicate is
   * preferable to silently losing a task result.
   */
  private deliveryConfirmed: Set<string> = new Set();
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
      // Serialize polls per task: setInterval does not await, so a slow read
      // could let the next tick start before this one finishes — overlapping
      // polls could double-deliver a result or fire an out-of-order pickup.
      if (this.polling.has(taskId)) return;
      this.polling.add(taskId);
      try {
        const entry = await this.munin.read(`tasks/${taskId}`, "status");
        // Bail if the task was stopped (cancel / timeout / shutdown) while the
        // read was in flight — no side effects after a stop.
        if (!entry || this.stopped || !this.activePolls.has(taskId)) return;

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
              // Delivery failed — clear the guard so a later poll retries, and
              // leave the marker unwritten (it means "acked", not "attempted").
              console.error(`Pickup ack failed for ${taskId}, will retry:`, err);
              this.pickupAcked.delete(taskId);
            }
          }
          return;
        }

        if (tags.includes("cancelled")) {
          await onComplete(STATUS_MESSAGES.cancelled(taskId));
          this.stopPolling(taskId);
          return;
        }

        // A callback failure means Telegram did not confirm delivery. Keep the
        // poll active and retry on the next interval; do not write a marker.
        if (!this.deliveryConfirmed.has(taskId)) {
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
          this.deliveryConfirmed.add(taskId);
        }

        // Persist only after Telegram confirms the send. If this write fails,
        // retry only the marker on the next tick — never resend in this process.
        try {
          await this.munin.write(
            `tasks/${taskId}`,
            "delivery",
            `Delivered to Telegram at ${new Date().toISOString()}`,
            ["delivered", `instance:${config.instanceId}`]
          );
        } catch (err) {
          console.error(
            `Delivery marker write failed for ${taskId}; will retry without resending:`,
            err
          );
          return;
        }
        this.stopPolling(taskId);
      } catch (err) {
        console.error(`Poll error for ${taskId}:`, err);
      } finally {
        this.polling.delete(taskId);
      }
    };

    const interval = setInterval(poll, config.pollIntervalMs);
    this.activePolls.set(taskId, interval);

    // Set max duration timeout
    const timeout = setTimeout(() => {
      const deliveryWasConfirmed = this.deliveryConfirmed.has(taskId);
      this.stopPolling(taskId);
      if (deliveryWasConfirmed) {
        console.error(
          `Delivery for ${taskId} was confirmed but its Munin marker could not be ` +
            `persisted before polling timed out; restart recovery may duplicate it.`
        );
        return;
      }
      void Promise.resolve()
        .then(() =>
          onComplete(
            STATUS_MESSAGES.pollTimeout(
              taskId,
              Math.round(config.maxPollDurationMs / 60000)
            )
          )
        )
        .catch((err) => {
          console.error(`Failed to deliver poll-timeout notice for ${taskId}:`, err);
        });
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
    this.deliveryConfirmed.delete(taskId);
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

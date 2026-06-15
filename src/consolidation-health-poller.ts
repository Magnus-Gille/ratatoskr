/**
 * Consolidation-health poller.
 *
 * Watches the Munin state entry written by the consolidation worker:
 *   namespace: "meta/system-health", key: "consolidation"
 *
 * Alerts the Telegram owner (via allowedUsers[0]) on status transitions:
 *   healthy → failing  : warning
 *   * → tripped        : alert
 *   failing|tripped → healthy : recovery
 *
 * De-dup: in-memory last-alerted state; re-alerts on new incidents
 * (different last_error_at after recovery). On restart while tripped the
 * state is unknown → treated as a fresh transition → one alert fires.
 */

import { Api } from "grammy";
import { config } from "./config.js";
import { MuninClient } from "./munin-client.js";

export interface ConsolidationHealthEntry {
  status: "healthy" | "failing" | "tripped";
  failures: number;
  max_failures: number;
  last_error?: string;
  last_error_at?: string;
  updated_at?: string;
}

export interface AlertState {
  /** Last status we sent an alert for, or null if never alerted. */
  lastAlertedStatus: "healthy" | "failing" | "tripped" | null;
  /** last_error_at of the incident we last alerted on, so recovery → re-trip fires again. */
  lastErrorAt: string | null;
}

export interface AlertDecision {
  message: string | null;
  nextState: AlertState;
}

/**
 * Pure decision function — no I/O.
 * Returns message to send (or null) and the next AlertState.
 */
export function decideAlert(
  prev: AlertState,
  current: ConsolidationHealthEntry
): AlertDecision {
  const { status, failures, max_failures, last_error, last_error_at } =
    current;

  // Healthy: only alert if we previously alerted about an unhealthy state
  if (status === "healthy") {
    const wasUnhealthy =
      prev.lastAlertedStatus !== null &&
      prev.lastAlertedStatus !== "healthy";
    if (wasUnhealthy) {
      return {
        message: "✅ Munin consolidation worker recovered.",
        nextState: {
          lastAlertedStatus: "healthy",
          lastErrorAt: null,
        },
      };
    }
    // Already healthy or never saw a problem — no message
    return {
      message: null,
      nextState: {
        lastAlertedStatus: prev.lastAlertedStatus ?? "healthy",
        lastErrorAt: null,
      },
    };
  }

  // Failing / tripped: check for new incident
  // A new incident is either:
  //   - a new status we haven't alerted about, or
  //   - the same terminal status re-appeared after recovery (new last_error_at)
  const isNewIncident =
    prev.lastAlertedStatus !== status ||
    (last_error_at != null && last_error_at !== prev.lastErrorAt);

  if (!isNewIncident) {
    // Same incident, already alerted — suppress
    return {
      message: null,
      nextState: prev,
    };
  }

  const nextState: AlertState = {
    lastAlertedStatus: status,
    lastErrorAt: last_error_at ?? null,
  };

  if (status === "tripped") {
    const errorLine = last_error ? `\nLast error: ${last_error}` : "";
    return {
      message:
        `🔴 Munin consolidation worker TRIPPED — ${failures}/${max_failures} failures.` +
        `${errorLine}\n` +
        `It will not drain the backlog until the server is restarted or the error is fixed.`,
      nextState,
    };
  }

  // status === "failing"
  const errorLine = last_error ? `\nLast error: ${last_error}` : "";
  return {
    message:
      `⚠️ Munin consolidation worker failing — ${failures}/${max_failures} failures.` +
      `${errorLine}`,
    nextState,
  };
}

export class ConsolidationHealthPoller {
  private munin: MuninClient;
  private botApi: Api;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private alertState: AlertState = {
    lastAlertedStatus: null,
    lastErrorAt: null,
  };
  private stopped = false;
  /** Consecutive Munin read failures — used only for logging throttle. */
  private consecutiveReadFailures = 0;
  private static readonly READ_FAILURE_LOG_THROTTLE = 5;

  constructor(munin: MuninClient, botApi: Api, intervalMs: number) {
    this.munin = munin;
    this.botApi = botApi;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer !== null) return;
    console.log(
      `Consolidation health poller started (interval: ${this.intervalMs}ms)`
    );
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing / manual trigger. */
  async poll(): Promise<void> {
    if (this.stopped) return;

    let entry;
    try {
      entry = await this.munin.read("meta/system-health", "consolidation");
      this.consecutiveReadFailures = 0;
    } catch (err) {
      this.consecutiveReadFailures++;
      // Log on first failure, then every N thereafter to avoid log spam
      if (
        this.consecutiveReadFailures === 1 ||
        this.consecutiveReadFailures %
          ConsolidationHealthPoller.READ_FAILURE_LOG_THROTTLE ===
          0
      ) {
        console.error(
          `Consolidation health poller: Munin read failed` +
            ` (attempt ${this.consecutiveReadFailures}):`,
          err
        );
      }
      return;
    }

    if (!entry) {
      // Entry not yet written by server — nothing to do
      return;
    }

    let health: ConsolidationHealthEntry;
    try {
      health = JSON.parse(entry.content) as ConsolidationHealthEntry;
    } catch (err) {
      console.error(
        "Consolidation health poller: failed to parse health entry:",
        err
      );
      return;
    }

    const { message, nextState } = decideAlert(this.alertState, health);
    this.alertState = nextState;

    if (!message) return;

    const chatId = parseInt(config.allowedUsers[0], 10);
    if (isNaN(chatId)) {
      console.error(
        "Consolidation health poller: no valid chat ID in allowedUsers"
      );
      return;
    }

    try {
      await this.botApi.sendMessage(chatId, message);
      console.log(
        `Consolidation health alert sent (status: ${health.status}, chatId: ${chatId})`
      );
    } catch (err) {
      console.error("Consolidation health poller: failed to send alert:", err);
    }
  }
}

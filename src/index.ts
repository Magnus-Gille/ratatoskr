import express from "express";
import { config, validateConfig } from "./config.js";
import { registerSendRoute } from "./send-handler.js";
import { buildHeimdallDescriptor } from "./descriptor.js";
import { createHeimdallNotifier } from "./alert.js";
import { MuninClient } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { createBot } from "./bot.js";
import { recoverActivePolls } from "./recovery.js";
import { ConsolidationHealthPoller } from "./consolidation-health-poller.js";
import { attachBindResilience } from "./listen.js";
import { TriageStats } from "./triage-stats.js";
import { DurableReminderQueue } from "./reminders.js";
import { registerReminderRoutes } from "./reminder-handler.js";

validateConfig();

const app = express();
const munin = new MuninClient({
  baseUrl: config.muninUrl,
  apiKey: config.muninApiKey,
});
const poller = new ResultPoller(munin);
const triageStats = new TriageStats();
const bot = createBot(munin, poller, triageStats);
const reminders = new DurableReminderQueue({
  storePath: config.reminderStorePath,
  sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text),
});
await reminders.initialize();
reminders.start();
const consolidationPoller = new ConsolidationHealthPoller(
  munin,
  bot.api,
  config.consolidationPollMs
);

let botConnected = false;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "ratatoskr",
    bot_connected: botConnected,
    active_polls: poller.activePollCount,
    pending_reminders: reminders.counts().pending,
    failed_reminders: reminders.counts().failed,
  });
});

// Heimdall self-descriptor (no auth) — Tier-1 discovery endpoint.
// Must remain unauthenticated (same as /health), NOT behind RATATOSKR_SEND_API_KEY.
// status/metrics are computed from live state (issue #27), not hardcoded.
app.get("/heimdall.json", (_req, res) => {
  res.json(
    buildHeimdallDescriptor({
      botConnected,
      activePolls: poller.activePollCount,
      triage: triageStats.snapshot(),
      reminders: reminders.counts(),
    })
  );
});

// Best-effort Heimdall echo for alert-envelope sends (issue #16). Enabled only
// when BOTH the URL and token are set — a URL without a token would POST an
// unauthenticated `Bearer ` that Heimdall's fail-closed ingest rejects, so we
// skip the echo entirely (validateConfig warns about that partial config).
const notifyHeimdall =
  config.heimdallIngestUrl && config.heimdallAlertToken
    ? createHeimdallNotifier({
        url: config.heimdallIngestUrl,
        token: config.heimdallAlertToken,
      })
    : undefined;

registerSendRoute(app, {
  sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text),
  allowedUsers: config.allowedUsers,
  sendApiKey: config.sendApiKey,
  host: config.host,
  notifyHeimdall,
});

registerReminderRoutes(app, {
  queue: reminders,
  allowedUsers: config.allowedUsers,
  sendApiKey: config.sendApiKey,
  host: config.host,
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Ratatoskr health endpoint on http://${config.host}:${config.port}/health`
  );
});
// When HOST is the Pi's Tailscale IP, the bind can fail with EADDRNOTAVAIL if
// tailscaled isn't up yet. Without this handler the unhandled 'error' event
// would crash-loop the whole process (Telegram bot included). See
// docs/remote-send.md → "Optional: make the bind resilient".
attachBindResilience(server, config.host, config.port);

bot
  .start({
    onStart: async () => {
      botConnected = true;
      console.log("Ratatoskr Telegram bot started (long-polling)");
      try {
        const recovered = await recoverActivePolls(munin, poller, bot.api);
        if (recovered > 0) {
          console.log(`Recovered ${recovered} task(s) from Munin`);
        }
      } catch (err) {
        console.error("Failed to recover active polls:", err);
        // Non-fatal — bot still works for new messages
      }
      consolidationPoller.start();
    },
  })
  .catch((err) => {
    console.error("Bot failed to start:", err);
    process.exit(1);
  });

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  bot.stop();
  botConnected = false;
  poller.stopAll();
  consolidationPoller.stop();
  reminders.stop();
  server.close(() => {
    console.log("Ratatoskr stopped.");
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import express from "express";
import { config, validateConfig } from "./config.js";
import { registerSendRoute } from "./send-handler.js";
import { createHeimdallNotifier } from "./alert.js";
import { MuninClient } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { createBot } from "./bot.js";
import { recoverActivePolls } from "./recovery.js";
import { ConsolidationHealthPoller } from "./consolidation-health-poller.js";
import { attachBindResilience } from "./listen.js";

validateConfig();

const app = express();
const munin = new MuninClient({
  baseUrl: config.muninUrl,
  apiKey: config.muninApiKey,
});
const poller = new ResultPoller(munin);
const bot = createBot(munin, poller);
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
  });
});

// Best-effort Heimdall echo for alert-envelope sends (issue #16). Skipped when
// HEIMDALL_INGEST_URL is unset — `undefined` notifier disables the echo path.
const notifyHeimdall = config.heimdallIngestUrl
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
  server.close(() => {
    console.log("Ratatoskr stopped.");
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

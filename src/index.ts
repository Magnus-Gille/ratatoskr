import express from "express";
import { config, validateConfig } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { createBot } from "./bot.js";
import { recoverActivePolls } from "./recovery.js";
import { ConsolidationHealthPoller } from "./consolidation-health-poller.js";

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

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "ratatoskr",
    bot_connected: botConnected,
    active_polls: poller.activePollCount,
  });
});

app.post("/api/send", async (req, res) => {
  const { chat_id, text } = req.body ?? {};
  if (typeof chat_id !== "number" || typeof text !== "string" || !text) {
    res.status(400).json({ error: "chat_id (number) and text (string) are required" });
    return;
  }
  if (!config.allowedUsers.includes(chat_id.toString())) {
    res.status(403).json({ error: "chat_id not in allowed users list" });
    return;
  }
  try {
    await bot.api.sendMessage(chat_id, text);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
    res.status(500).json({ error: String(err) });
  }
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Ratatoskr health endpoint on http://${config.host}:${config.port}/health`
  );
});

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

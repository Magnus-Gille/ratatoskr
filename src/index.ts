import express from "express";
import { config, validateConfig } from "./config.js";
import { MuninClient } from "./munin-client.js";
import { ResultPoller } from "./result-poller.js";
import { createBot } from "./bot.js";

validateConfig();

const app = express();
const munin = new MuninClient({
  baseUrl: config.muninUrl,
  apiKey: config.muninApiKey,
});
const poller = new ResultPoller(munin);
const bot = createBot(munin, poller);

let botConnected = false;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "ratatoskr",
    bot_connected: botConnected,
    active_polls: poller.activePollCount,
  });
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Ratatoskr health endpoint on http://${config.host}:${config.port}/health`
  );
});

bot
  .start({
    onStart: () => {
      botConnected = true;
      console.log("Ratatoskr Telegram bot started (long-polling)");
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
  server.close(() => {
    console.log("Ratatoskr stopped.");
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

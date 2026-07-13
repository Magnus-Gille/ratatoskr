import { Api } from "grammy";
import { config } from "./config.js";
import { AbortContext, runtimeAbort } from "./abort-context.js";

export const TELEGRAM_FILE_TIMEOUT_MS = 30_000;

export interface TelegramDownloadOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  abortContext?: AbortContext;
}

async function getTelegramFile(
  api: Api,
  fileId: string,
  options: TelegramDownloadOptions
) {
  const timeoutMs = options.timeoutMs ?? TELEGRAM_FILE_TIMEOUT_MS;
  const abortContext = options.abortContext ?? runtimeAbort;
  const signal = abortContext.deadline(timeoutMs);
  try {
    // grammY's Node shim types AbortSignal through abort-controller, while
    // Node's native signal is runtime-compatible but structurally different.
    return await api.getFile(
      fileId,
      signal as Parameters<Api["getFile"]>[1]
    );
  } catch (err) {
    throw abortContext.normalize(err, signal, "Telegram getFile request", timeoutMs);
  }
}

async function fetchTelegramFile(
  url: string,
  options: TelegramDownloadOptions
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? TELEGRAM_FILE_TIMEOUT_MS;
  const abortContext = options.abortContext ?? runtimeAbort;
  const signal = abortContext.deadline(timeoutMs);
  try {
    const res = await (options.fetchImpl ?? fetch)(url, { signal });
    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw abortContext.normalize(err, signal, "Telegram file download", timeoutMs);
  }
}

export interface DownloadedImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export async function downloadPhoto(
  api: Api,
  fileId: string,
  options: TelegramDownloadOptions = {}
): Promise<DownloadedImage> {
  const file = await getTelegramFile(api, fileId, options);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram returned no file_path");

  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const buffer = await fetchTelegramFile(url, options);
  const base64 = buffer.toString("base64");

  // Detect media type from extension
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mediaType =
    ext === "png" ? "image/png" :
    ext === "gif" ? "image/gif" :
    ext === "webp" ? "image/webp" :
    "image/jpeg";  // Telegram usually serves JPEG

  return { base64, mediaType };
}

export interface DownloadedFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Download an arbitrary Telegram file by file_id as raw bytes (used for voice
 * notes / audio, issue #1). Infers a sensible audio MIME from the file
 * extension, falling back to the caller-supplied `fallbackMime`.
 */
export async function downloadFile(
  api: Api,
  fileId: string,
  fallbackMime = "application/octet-stream",
  options: TelegramDownloadOptions = {}
): Promise<DownloadedFile> {
  const file = await getTelegramFile(api, fileId, options);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram returned no file_path");

  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const buffer = await fetchTelegramFile(url, options);
  const filename = filePath.split("/").pop() || "file";
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeType =
    ext === "oga" || ext === "ogg" ? "audio/ogg" :
    ext === "mp3" ? "audio/mpeg" :
    ext === "m4a" || ext === "mp4" ? "audio/mp4" :
    ext === "wav" ? "audio/wav" :
    ext === "webm" ? "audio/webm" :
    fallbackMime;

  return { buffer, filename, mimeType };
}

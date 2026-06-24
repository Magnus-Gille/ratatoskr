import { Api } from "grammy";
import { config } from "./config.js";

export interface DownloadedImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export async function downloadPhoto(
  api: Api,
  fileId: string
): Promise<DownloadedImage> {
  const file = await api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram returned no file_path");

  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
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
  fallbackMime = "application/octet-stream"
): Promise<DownloadedFile> {
  const file = await api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram returned no file_path");

  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
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

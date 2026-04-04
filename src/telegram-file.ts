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

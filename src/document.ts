import type { DownloadedFile } from "./telegram-file.js";

export const MAX_PDF_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_DOCUMENT_BYTES = 128 * 1024;

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json"]);

export type ConciergeDocument =
  | { kind: "pdf"; base64: string; title: string }
  | { kind: "text"; text: string; title: string };

function extension(filename: string | undefined): string {
  return filename?.split(".").pop()?.toLowerCase() ?? "";
}

function documentKind(
  filename: string | undefined,
  mimeType: string | undefined
): "pdf" | "text" | null {
  const mime = mimeType?.toLowerCase().split(";", 1)[0].trim();
  const ext = extension(filename);
  if (mime === "application/pdf") return "pdf";
  if (TEXT_MIME_TYPES.has(mime ?? "")) return "text";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

function safeTitle(filename: string | undefined): string {
  const title = (filename || "document")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return title || "document";
}

/** Validate Telegram metadata before downloading or sending a document off-box. */
export function checkDocument(
  filename: string | undefined,
  mimeType: string | undefined,
  fileSize: number | undefined
): string | null {
  const kind = documentKind(filename, mimeType);
  if (!kind) {
    return "I can read PDF, TXT, Markdown, CSV, and JSON documents. Send this one as text or PDF.";
  }
  const maxBytes = kind === "pdf" ? MAX_PDF_DOCUMENT_BYTES : MAX_TEXT_DOCUMENT_BYTES;
  if (fileSize !== undefined && fileSize > maxBytes) {
    const displayLimit =
      kind === "pdf"
        ? `${maxBytes / 1024 / 1024} MB`
        : `${maxBytes / 1024} KB`;
    return `That ${kind === "pdf" ? "PDF" : "text document"} is too large (max ${displayLimit}).`;
  }
  return null;
}

/** Convert downloaded bytes into an Anthropic document content block payload. */
export function prepareDocument(
  file: DownloadedFile,
  originalFilename?: string,
  declaredMimeType?: string
): ConciergeDocument {
  const filename = originalFilename || file.filename;
  const mimeType = declaredMimeType || file.mimeType;
  const reason = checkDocument(filename, mimeType, file.buffer.byteLength);
  if (reason) throw new Error(reason);

  if (documentKind(filename, mimeType) === "pdf") {
    return {
      kind: "pdf",
      base64: file.buffer.toString("base64"),
      title: safeTitle(filename),
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
  } catch {
    throw new Error("That text document is not valid UTF-8.");
  }
  if (!text.trim()) throw new Error("That document is empty.");
  return { kind: "text", text, title: safeTitle(filename) };
}

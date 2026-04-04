export const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Extract human-readable slug from task IDs.
 * "20260404-153022-fix-navbar-css" → "fix-navbar-css"
 */
export function shortId(taskId: string): string {
  const parts = taskId.split("-");
  if (parts.length < 3) return taskId;
  return parts.slice(2).join("-");
}

/**
 * Parse Hugin result markdown to extract the response body and failure status.
 */
export function extractResultBody(raw: string): { body: string; failed: boolean } {
  // Parse exit code
  const exitCodeMatch = raw.match(/\*\*Exit code:\*\*\s*(\d+)/i);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;
  const failed = exitCode !== 0;

  // Find ### Response section
  const responseMatch = raw.match(/^###\s+Response\s*$/im);
  if (!responseMatch || responseMatch.index === undefined) {
    // No Response section found — return full text as fallback
    return { body: raw.trim(), failed };
  }

  const afterHeader = raw.slice(responseMatch.index + responseMatch[0].length);
  const body = afterHeader.trim();

  return { body, failed };
}

/**
 * Truncate text to Telegram's max length, adding a footer pointing to Munin.
 */
export function truncateForTelegram(text: string, taskId: string): string {
  const footer = `\n\nFull result in Munin.`;
  const maxContent = TELEGRAM_MAX_LENGTH - footer.length - 10;
  if (text.length <= maxContent) return text + footer;
  return text.slice(0, maxContent) + "..." + footer;
}

/** @deprecated Use truncateForTelegram */
export const truncateResult = truncateForTelegram;

/**
 * Strip markdown syntax to produce plain text suitable for Telegram chat.
 * Preserves content but removes formatting markers.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Fenced code blocks — keep content, remove fences and language tag
  result = result.replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, "$1");

  // Inline code
  result = result.replace(/`([^`]+)`/g, "$1");

  // Headings — remove # prefix
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Bold+italic (***text***), bold (**text**), italic (*text*)
  result = result.replace(/\*{3}(.+?)\*{3}/g, "$1");
  result = result.replace(/\*{2}(.+?)\*{2}/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");

  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Images ![alt](url) → alt (must run before links)
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Links [text](url) → text
  result = result.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Blockquotes
  result = result.replace(/^>\s?/gm, "");

  // Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, "");

  // Unordered list markers — keep indentation and text
  result = result.replace(/^(\s*)[-*+]\s+/gm, "$1");

  // Collapse excessive blank lines (3+ → 2)
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Format a raw Hugin result for Telegram delivery.
 * Strips metadata, extracts the response body, strips markdown, prefixes failures.
 */
export function formatResult(raw: string, taskId: string): string {
  const { body, failed } = extractResultBody(raw);

  let result: string;
  if (failed) {
    if (body) {
      result = `That didn't work.\n\n${stripMarkdown(body)}`;
    } else {
      result = STATUS_MESSAGES.failedFallback;
    }
  } else {
    result = body ? stripMarkdown(body) : STATUS_MESSAGES.completedFallback;
  }

  return truncateForTelegram(result, taskId);
}

/**
 * Terse lifecycle status messages.
 */
export const STATUS_MESSAGES = {
  cancelled: (taskId: string) => `Cancelled ${shortId(taskId)}.`,
  pollTimeout: (taskId: string, minutes: number) =>
    `Lost track of ${shortId(taskId)} after ${minutes} min. Check Munin.`,
  completedFallback: "Done.",
  failedFallback: "That failed. No output — check Munin for details.",
};

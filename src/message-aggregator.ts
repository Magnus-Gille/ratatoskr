/**
 * MessageAggregator — debounces rapid Telegram message fragments back into a
 * single logical message.
 *
 * Telegram splits messages that exceed 4096 characters into multiple parts and
 * sends them one after the other in quick succession.  Without aggregation each
 * fragment would be treated as an independent task by the concierge.
 *
 * Usage:
 *   const aggregator = new MessageAggregator(2500, handler);
 *   aggregator.push(chatId, fragment);
 *
 * When no new fragment arrives for `windowMs` milliseconds the accumulated
 * text for that chatId is flushed to `handler`.
 */

export type MessageHandler = (chatId: string, text: string) => void;

interface PendingMessage {
  parts: string[];
  timer: ReturnType<typeof setTimeout>;
}

export class MessageAggregator {
  private readonly windowMs: number;
  private readonly handler: MessageHandler;
  private readonly pending = new Map<string, PendingMessage>();

  constructor(windowMs: number, handler: MessageHandler) {
    this.windowMs = windowMs;
    this.handler = handler;
  }

  push(chatId: string, text: string): void {
    const existing = this.pending.get(chatId);

    if (existing) {
      // Reset the debounce window and append the new fragment.
      clearTimeout(existing.timer);
      existing.parts.push(text);
      existing.timer = setTimeout(() => this.flush(chatId), this.windowMs);
    } else {
      // First fragment — start aggregation window.
      const timer = setTimeout(() => this.flush(chatId), this.windowMs);
      this.pending.set(chatId, { parts: [text], timer });
    }
  }

  /** Flush immediately (used in tests and for graceful shutdown). */
  flushNow(chatId: string): void {
    const entry = this.pending.get(chatId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.flush(chatId);
  }

  /** Flush all pending messages (graceful shutdown). */
  flushAll(): void {
    for (const chatId of this.pending.keys()) {
      this.flushNow(chatId);
    }
  }

  private flush(chatId: string): void {
    const entry = this.pending.get(chatId);
    if (!entry) return;
    this.pending.delete(chatId);
    const combined = entry.parts.join(" ");
    this.handler(chatId, combined);
  }

  /** Number of chat IDs currently waiting for flush (for tests). */
  get pendingCount(): number {
    return this.pending.size;
  }
}

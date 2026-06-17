export interface TrackedMessage {
  type: "result" | "status" | "clarify" | "answer" | "ack";
  taskId?: string;
  snippet?: string; // first ~200 chars of the message content
  replyToText?: string; // full text of the replied-to message (up to 1000 chars)
  timestamp: number;
}

export class MessageTracker {
  private messages = new Map<number, TrackedMessage>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3600000) {
    // 1 hour default
    this.ttlMs = ttlMs;
  }

  track(messageId: number, meta: Omit<TrackedMessage, "timestamp">): void {
    this.cleanup();
    this.messages.set(messageId, { ...meta, timestamp: Date.now() });
  }

  lookup(messageId: number): TrackedMessage | null {
    this.cleanup();
    return this.messages.get(messageId) ?? null;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, msg] of this.messages) {
      if (msg.timestamp < cutoff) this.messages.delete(id);
    }
  }

  get size(): number {
    return this.messages.size;
  }
}

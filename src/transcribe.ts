/**
 * Audio transcription client (issue #1 — voice messages).
 *
 * Posts audio to an OpenAI-compatible `/v1/audio/transcriptions` endpoint
 * (multipart `file` + `model`, returns `{ text }`). Magnus runs this against a
 * LOCAL Whisper server (m5 / on-box), configured via RATATOSKR_TRANSCRIBE_URL —
 * audio never leaves his hardware. The endpoint is optional: when unset the bot
 * tells the user voice isn't wired up rather than failing (see bot.ts).
 */

/** Hard ceiling on a voice file we'll download/transcribe (Whisper's own limit). */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

/**
 * Decide whether a voice note is within limits BEFORE downloading it. Returns a
 * user-facing rejection reason, or null if acceptable. Pure — uses only the
 * Telegram metadata (duration seconds, file_size bytes) available up front.
 */
export function checkVoiceLimits(
  durationS: number | undefined,
  fileSizeBytes: number | undefined,
  maxDurationS: number,
  maxBytes: number = MAX_VOICE_BYTES
): string | null {
  if (typeof durationS === "number" && durationS > maxDurationS) {
    return `That voice note is too long (${durationS}s, max ${maxDurationS}s). Send a shorter one or use text.`;
  }
  if (typeof fileSizeBytes === "number" && fileSizeBytes > maxBytes) {
    return `That voice note is too large to transcribe. Send a shorter one or use text.`;
  }
  return null;
}

export interface TranscriberOptions {
  /** OpenAI-compatible transcription endpoint, e.g. http://m5:8080/v1/audio/transcriptions */
  url: string;
  /** Model name the endpoint expects (e.g. "whisper-1" or a local model id). */
  model: string;
  /** Optional Bearer token, if the local endpoint is auth-gated. */
  token?: string;
  /** Per-request timeout. Transcription is slow, so default is generous (60s). */
  timeoutMs?: number;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a transcribe function: (audio, filename, mimeType) → transcript text.
 * Throws on a network error, timeout, non-2xx response, or empty transcript so
 * the caller can surface a clear failure to the user.
 */
export function createTranscriber(
  opts: TranscriberOptions
): (audio: Buffer, filename: string, mimeType: string) => Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const doFetch = opts.fetchImpl ?? fetch;

  return async (
    audio: Buffer,
    filename: string,
    mimeType: string
  ): Promise<string> => {
    const form = new FormData();
    // Copy into a fresh Uint8Array so the Blob part is typed against ArrayBuffer
    // (Buffer's backing store is ArrayBufferLike and isn't a valid BlobPart).
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    form.append("model", opts.model);

    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Transcription endpoint returned ${res.status}`);
    }

    let data: { text?: unknown };
    try {
      data = (await res.json()) as { text?: unknown };
    } catch {
      throw new Error("Transcription endpoint returned invalid JSON");
    }
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) {
      throw new Error("Transcription returned empty text");
    }
    return text;
  };
}

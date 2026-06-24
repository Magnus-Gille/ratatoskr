import { describe, it, expect, vi } from "vitest";
import {
  createTranscriber,
  checkVoiceLimits,
  MAX_VOICE_BYTES,
} from "../src/transcribe.js";

describe("checkVoiceLimits", () => {
  it("accepts a note within duration and size limits", () => {
    expect(checkVoiceLimits(30, 100_000, 300)).toBeNull();
  });

  it("rejects a note longer than the max duration", () => {
    const reason = checkVoiceLimits(600, 100, 300);
    expect(reason).toMatch(/too long/i);
  });

  it("rejects a note larger than the max bytes", () => {
    const reason = checkVoiceLimits(10, MAX_VOICE_BYTES + 1, 300);
    expect(reason).toMatch(/too large/i);
  });

  it("tolerates absent metadata (duration/size undefined → accepted)", () => {
    expect(checkVoiceLimits(undefined, undefined, 300)).toBeNull();
  });
});

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const audio = Buffer.from("fake-ogg-bytes");

describe("createTranscriber", () => {
  it("POSTs multipart (file + model) to the configured endpoint and returns the text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ text: "  hello world  " }));
    const transcribe = createTranscriber({
      url: "http://m5:8080/v1/audio/transcriptions",
      model: "whisper-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const text = await transcribe(audio, "voice.oga", "audio/ogg");
    expect(text).toBe("hello world"); // trimmed

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://m5:8080/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a Bearer token when configured, and omits it otherwise", async () => {
    const withTok = vi.fn().mockResolvedValue(okJson({ text: "x" }));
    await createTranscriber({
      url: "http://h/t",
      model: "m",
      token: "sekret",
      fetchImpl: withTok as unknown as typeof fetch,
    })(audio, "a.oga", "audio/ogg");
    expect(withTok.mock.calls[0][1].headers.Authorization).toBe("Bearer sekret");

    const noTok = vi.fn().mockResolvedValue(okJson({ text: "x" }));
    await createTranscriber({
      url: "http://h/t",
      model: "m",
      fetchImpl: noTok as unknown as typeof fetch,
    })(audio, "a.oga", "audio/ogg");
    expect(noTok.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 } as Response);
    const transcribe = createTranscriber({
      url: "http://h/t",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transcribe(audio, "a.oga", "audio/ogg")).rejects.toThrow(/503/);
  });

  it("throws when the endpoint returns empty/absent text", async () => {
    const empty = createTranscriber({
      url: "http://h/t",
      model: "m",
      fetchImpl: vi.fn().mockResolvedValue(okJson({ text: "   " })) as unknown as typeof fetch,
    });
    await expect(empty(audio, "a.oga", "audio/ogg")).rejects.toThrow(/empty/i);

    const absent = createTranscriber({
      url: "http://h/t",
      model: "m",
      fetchImpl: vi.fn().mockResolvedValue(okJson({})) as unknown as typeof fetch,
    });
    await expect(absent(audio, "a.oga", "audio/ogg")).rejects.toThrow(/empty/i);
  });

  it("throws a transcription-specific error on invalid JSON", async () => {
    const transcribe = createTranscriber({
      url: "http://h/t",
      model: "m",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      } as unknown as Response) as unknown as typeof fetch,
    });
    await expect(transcribe(audio, "a.oga", "audio/ogg")).rejects.toThrow(
      /transcription endpoint returned invalid json/i
    );
  });

  it("propagates a network/timeout rejection", async () => {
    const transcribe = createTranscriber({
      url: "http://h/t",
      model: "m",
      fetchImpl: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")) as unknown as typeof fetch,
    });
    await expect(transcribe(audio, "a.oga", "audio/ogg")).rejects.toThrow(/ETIMEDOUT/);
  });
});

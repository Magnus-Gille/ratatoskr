import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the config module
vi.mock("../src/config.js", () => ({
  config: {
    telegramBotToken: "test-bot-token",
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { downloadPhoto } from "../src/telegram-file.js";

function makeApi(filePath: string | undefined) {
  return {
    getFile: vi.fn().mockResolvedValue({ file_path: filePath }),
  };
}

function makeFetchResponse(data: Buffer, ok = true, status = 200) {
  // Use slice to get a standalone ArrayBuffer (Buffer shares a memory pool)
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return {
    ok,
    status,
    arrayBuffer: vi.fn().mockResolvedValue(arrayBuffer),
  };
}

describe("downloadPhoto", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should download a JPEG and return correct base64 and mediaType", async () => {
    const imageData = Buffer.from("fake-jpeg-data");
    mockFetch.mockResolvedValue(makeFetchResponse(imageData));
    const api = makeApi("photos/file_0.jpg");

    const result = await downloadPhoto(api as never, "file-id-123");

    expect(api.getFile).toHaveBeenCalledWith("file-id-123");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottest-bot-token/photos/file_0.jpg"
    );
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.base64).toBe(imageData.toString("base64"));
  });

  it("should detect PNG media type from .png extension", async () => {
    const imageData = Buffer.from("fake-png-data");
    mockFetch.mockResolvedValue(makeFetchResponse(imageData));
    const api = makeApi("photos/file_0.png");

    const result = await downloadPhoto(api as never, "file-id-png");

    expect(result.mediaType).toBe("image/png");
  });

  it("should detect WebP media type from .webp extension", async () => {
    const imageData = Buffer.from("fake-webp-data");
    mockFetch.mockResolvedValue(makeFetchResponse(imageData));
    const api = makeApi("photos/file_0.webp");

    const result = await downloadPhoto(api as never, "file-id-webp");

    expect(result.mediaType).toBe("image/webp");
  });

  it("should detect GIF media type from .gif extension", async () => {
    const imageData = Buffer.from("fake-gif-data");
    mockFetch.mockResolvedValue(makeFetchResponse(imageData));
    const api = makeApi("photos/file_0.gif");

    const result = await downloadPhoto(api as never, "file-id-gif");

    expect(result.mediaType).toBe("image/gif");
  });

  it("should default to image/jpeg for unknown extensions", async () => {
    const imageData = Buffer.from("fake-data");
    mockFetch.mockResolvedValue(makeFetchResponse(imageData));
    const api = makeApi("photos/file_0.bmp");

    const result = await downloadPhoto(api as never, "file-id-bmp");

    expect(result.mediaType).toBe("image/jpeg");
  });

  it("should throw if Telegram returns no file_path", async () => {
    const api = makeApi(undefined);

    await expect(downloadPhoto(api as never, "file-id-no-path")).rejects.toThrow(
      "Telegram returned no file_path"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should throw if fetch returns a non-OK response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const api = makeApi("photos/file_0.jpg");

    await expect(downloadPhoto(api as never, "file-id-404")).rejects.toThrow(
      "Failed to download file: 404"
    );
  });
});

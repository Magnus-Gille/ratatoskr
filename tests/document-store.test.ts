import { access, mkdir, mkdtemp, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_RETENTION_MS,
  removeStoredDocument,
  storeDocument,
} from "../src/document-store.js";

describe("storeDocument", () => {
  it("persists bytes under a sanitized unique path with private permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ratatoskr-documents-"));
    const localPath = await storeDocument(
      root,
      { buffer: Buffer.from("source bytes"), filename: "telegram-file", mimeType: "text/plain" },
      "../../invoice Q2.txt"
    );
    expect(path.dirname(localPath).startsWith(root + path.sep)).toBe(true);
    expect(path.basename(localPath)).toBe("invoice_Q2.txt");
    expect(await readFile(localPath, "utf8")).toBe("source bytes");
    expect((await stat(localPath)).mode & 0o777).toBe(0o600);
  });

  it("prunes attachment directories older than the retention window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ratatoskr-documents-"));
    const oldDirectory = path.join(root, "old-attachment");
    await mkdir(oldDirectory);
    const old = new Date(Date.now() - DOCUMENT_RETENTION_MS - 1000);
    await utimes(oldDirectory, old, old);
    await storeDocument(
      root,
      { buffer: Buffer.from("new"), filename: "new.txt", mimeType: "text/plain" },
      "new.txt"
    );
    await expect(access(oldDirectory)).rejects.toThrow();
  });

  it("removes one stored attachment without allowing root deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ratatoskr-documents-"));
    const localPath = await storeDocument(
      root,
      { buffer: Buffer.from("x"), filename: "x.txt", mimeType: "text/plain" }
    );
    await removeStoredDocument(root, localPath);
    await expect(access(localPath)).rejects.toThrow();
    await removeStoredDocument(root, root);
    await expect(access(root)).resolves.toBeUndefined();
  });
});

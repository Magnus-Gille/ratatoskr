import { describe, expect, it } from "vitest";
import {
  checkDocument,
  MAX_PDF_DOCUMENT_BYTES,
  MAX_TEXT_DOCUMENT_BYTES,
  prepareDocument,
} from "../src/document.js";

describe("document handling", () => {
  it("accepts supported MIME types and safe filename fallbacks", () => {
    expect(checkDocument("report.pdf", "application/pdf", 100)).toBeNull();
    expect(checkDocument("notes.md", "application/octet-stream", 100)).toBeNull();
    expect(checkDocument("data", "application/json", 100)).toBeNull();
    expect(checkDocument("data", "text/plain; charset=utf-8", 100)).toBeNull();
    expect(checkDocument("limit.txt", "text/plain", MAX_TEXT_DOCUMENT_BYTES)).toBeNull();
    expect(checkDocument("unknown.txt", "text/plain", undefined)).toBeNull();
    expect(checkDocument("mislabeled.pdf", "text/plain", 100)).toBeNull();
  });

  it("rejects unsupported and oversized documents before download", () => {
    expect(checkDocument("archive.zip", "application/zip", 100)).toMatch(/PDF/);
    expect(
      checkDocument("large.pdf", "application/pdf", MAX_PDF_DOCUMENT_BYTES + 1)
    ).toMatch(/too large/i);
    expect(
      checkDocument("large.txt", "text/plain", MAX_TEXT_DOCUMENT_BYTES + 1)
    ).toMatch(/128 KB/i);
  });

  it("prepares PDFs as base64 and sanitizes the title", () => {
    const result = prepareDocument(
      { buffer: Buffer.from("pdf"), filename: "telegram-file", mimeType: "application/pdf" },
      "quarterly\nreport.pdf",
      "application/pdf"
    );
    expect(result).toEqual({
      kind: "pdf",
      base64: Buffer.from("pdf").toString("base64"),
      title: "quarterly report.pdf",
    });
  });

  it("prepares UTF-8 text and rejects binary or empty content", () => {
    expect(
      prepareDocument(
        { buffer: Buffer.from("hello åäö"), filename: "notes.md", mimeType: "text/markdown" }
      )
    ).toEqual({ kind: "text", text: "hello åäö", title: "notes.md" });

    expect(() =>
      prepareDocument({
        buffer: Buffer.from([0xff, 0xfe]),
        filename: "bad.txt",
        mimeType: "text/plain",
      })
    ).toThrow(/UTF-8/);
    expect(() =>
      prepareDocument({
        buffer: Buffer.from("   "),
        filename: "empty.txt",
        mimeType: "text/plain",
      })
    ).toThrow(/empty/);
  });
});

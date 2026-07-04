// Tests for WebSocket close reason truncation.
import { describe, expect, it } from "vitest";
import { truncateCloseReason } from "./close-reason.js";

describe("truncateCloseReason", () => {
  it("keeps ASCII reasons within the byte cap", () => {
    expect(truncateCloseReason("x".repeat(125), 120)).toBe("x".repeat(120));
  });

  it("does not split a multibyte UTF-8 sequence when truncating", () => {
    const out = truncateCloseReason(`${"x".repeat(118)}${"😀".repeat(5)}`, 120);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(120);
    expect(out).toBe("x".repeat(118));
    expect(out).not.toContain("\uFFFD");
  });

  it("preserves a complete multibyte character that fits within the cap", () => {
    const out = truncateCloseReason(`${"x".repeat(116)}😀tail`, 120);

    expect(Buffer.byteLength(out, "utf8")).toBe(120);
    expect(out).toBe(`${"x".repeat(116)}😀`);
  });
});

// Close reason helpers keep WebSocket handshake failure text within RFC byte limits.
import { Buffer } from "node:buffer";

/**
 * WebSocket close reason utilities.
 */
const CLOSE_REASON_MAX_BYTES = 120;

/** Truncates close reasons to the RFC-safe byte limit used during handshake failures. */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    return "invalid handshake";
  }
  const buf = Buffer.from(reason);
  if (buf.length <= maxBytes) {
    return reason;
  }
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const lead = buf[end - 1];
  if (lead !== undefined) {
    const expectedLength =
      (lead & 0x80) === 0x00
        ? 1
        : (lead & 0xe0) === 0xc0
          ? 2
          : (lead & 0xf0) === 0xe0
            ? 3
            : (lead & 0xf8) === 0xf0
              ? 4
              : 1;
    if (end - 1 + expectedLength > maxBytes) {
      end -= 1;
    }
  }
  return buf.subarray(0, Math.max(0, end)).toString();
}

import type { StartFrame } from "../sdk/src/types.ts";

// The stdout cap limits one Deno -> host frame. The StartFrame cap is an
// independent host -> runner budget; both are currently 16 MiB. The host
// validates the actual config + state encoding before persistence, so the shared
// value cannot create an unreplayable state.
export const MAX_START_FRAME_BYTES = 16 * 1024 * 1024;

export type StdinReader = {
  read(buffer: Uint8Array): Promise<number | null>;
};

/**
 * Read exactly the first NDJSON line from stdin as the StartFrame.
 *
 * O(n) over stdin bytes: each new chunk is scanned for a newline; chunks are
 * retained and concatenated only once when the line is complete (or EOF).
 * The cap counts the complete NDJSON frame, including its newline when present.
 * Trailing bytes after the newline in the same chunk are discarded and do not
 * count toward the cap.
 *
 * Does not consume the rest of stdin after the first line: later stdin EOF is
 * the cooperative-cancel signal. Fatal UTF-8 only (no lossy accept).
 */
export async function readStartFrame(
  stdin: StdinReader = Deno.stdin,
  maxBytes: number = MAX_START_FRAME_BYTES,
): Promise<StartFrame> {
  const chunks: Uint8Array[] = [];
  // Bytes retained for the first line so far (excludes discarded trailing).
  let lineBytes = 0;

  while (true) {
    // Retained subarray views share their backing buffer, so each read needs a
    // fresh allocation. Reusing one buffer would overwrite earlier chunks.
    const buffer = new Uint8Array(1024);
    const read = await stdin.read(buffer);
    if (read === null) {
      break;
    }
    const piece = buffer.subarray(0, read);
    const newlineInPiece = indexOfNewline(piece);

    if (newlineInPiece !== -1) {
      // The newline is part of the complete NDJSON frame and counts toward the cap.
      const linePart = piece.subarray(0, newlineInPiece);
      if (lineBytes + linePart.byteLength + 1 > maxBytes) {
        throw new Error(`start frame exceeded max size of ${maxBytes} bytes`);
      }
      chunks.push(linePart);
      // Bytes after the newline in this chunk are discarded (not capped).
      return parseStartFrameLine(concatBytes(chunks));
    }

    if (lineBytes + piece.byteLength > maxBytes) {
      throw new Error(`start frame exceeded max size of ${maxBytes} bytes`);
    }
    chunks.push(piece);
    lineBytes += piece.byteLength;
  }

  if (lineBytes === 0 && chunks.length === 0) {
    throw new Error("missing start frame");
  }
  // EOF without newline: accept a single complete line if present.
  return parseStartFrameLine(concatBytes(chunks));
}

export function parseStartFrameLine(lineBytes: Uint8Array): StartFrame {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
  } catch {
    throw new Error("start frame is not valid UTF-8");
  }
  const line = text.trim();
  if (!line) {
    throw new Error("missing start frame");
  }
  try {
    return JSON.parse(line) as StartFrame;
  } catch {
    // V8 SyntaxError messages may quote the malformed input, which can contain
    // connector secrets before the runner has installed value redaction.
    throw new Error("start frame is not valid JSON");
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function indexOfNewline(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a) {
      return i;
    }
  }
  return -1;
}

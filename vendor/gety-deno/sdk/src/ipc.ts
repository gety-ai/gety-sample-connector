import type {
  DeniedPermission,
  JsonValue,
  PermissionDenial,
  RunnerLogLevel,
  RunnerMessage,
  WireDocUpdate,
} from "./types.ts";

type DenoLike = {
  errors?: { NotCapable?: abstract new (...args: never[]) => Error };
  inspect?: (value: unknown, options?: { depth?: number }) => string;
  stdout?: {
    writeSync?: (data: Uint8Array) => number;
  };
};

// Bounds the `cause` chain walk; author code can build cyclic chains.
const MAX_CAUSE_DEPTH = 8;
// Mirrors MAX_PERMISSION_TARGET_CHARS in
// libs/gety-deno-connectors/src/connector/ipc.rs.
const MAX_PERMISSION_TARGET_CHARS = 512;
const DENIED_PERMISSIONS: Record<DeniedPermission, true> = {
  read: true,
  write: true,
  net: true,
  env: true,
  run: true,
  sys: true,
  ffi: true,
  import: true,
};
const permissionDenialPattern = /Requires (\w+) access to "([^"]*)"/;

type PollResultLike = {
  updates: WireDocUpdate[];
  state?: unknown;
};

const encoder = new TextEncoder();
/** @internal Soft split target for ordinary batches. */
// Large single docs may use the hard cap below.
export const TARGET_BATCH_FRAME_BYTES = 512 * 1024;
/** @internal Hard cap for one Deno -> host stdout frame. */
// Mirrors DEFAULT_STDOUT_MAX_LINE in libs/gety-deno-connectors/src/process.rs.
// Ecosystem defaults vary (Kafka ~1 MiB, gRPC 4 MiB, tokio-util 8 MiB,
// MongoDB 16 MiB). Gety uses 16 MiB to cover its 10 MiB content cap plus JSON
// envelope while keeping each stdout NDJSON frame bounded.
export const MAX_STDOUT_FRAME_BYTES = 16 * 1024 * 1024;
const sensitiveKeyPattern =
  /(password|token|secret|api[_-]?key|authorization)/i;
const sensitiveValues = new Set<string>();

let installed = false;

export function encodeRunnerMessage(message: RunnerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function writeRunnerMessage(message: RunnerMessage): void {
  writeFrame(encoder.encode(encodeRunnerMessage(message)));
}

export function writePollResultMessages(result: PollResultLike): void {
  const hasState = Object.prototype.hasOwnProperty.call(result, "state");
  const state = hasState ? (result.state as JsonValue) : undefined;

  if (result.updates.length === 0) {
    writeBatchChunk([], hasState, state);
    return;
  }

  // A batch frame is the empty-batch frame plus each update's JSON and one
  // comma between updates, so sizes are tracked as running byte totals and
  // every update is encoded once for sizing instead of re-encoding the chunk.
  const emptyFrameBytes = batchFrameBytes([], false, undefined);
  let chunk: WireDocUpdate[] = [];
  let chunkFrameBytes = emptyFrameBytes;
  let lastUpdateBytes = 0;
  for (const update of result.updates) {
    lastUpdateBytes = encoder.encode(JSON.stringify(update)).byteLength;
    if (
      chunk.length > 0 &&
      chunkFrameBytes + 1 + lastUpdateBytes > TARGET_BATCH_FRAME_BYTES
    ) {
      writeBatchChunk(chunk, false, undefined);
      chunk = [];
      chunkFrameBytes = emptyFrameBytes;
    }

    chunkFrameBytes += (chunk.length > 0 ? 1 : 0) + lastUpdateBytes;
    chunk.push(update);
    if (chunkFrameBytes > MAX_STDOUT_FRAME_BYTES) {
      throw new Error("single Deno doc update exceeds IPC frame size limit");
    }
  }

  const stateBytes = batchFrameBytes([], hasState, state) - emptyFrameBytes;
  if (
    chunk.length > 1 &&
    chunkFrameBytes + stateBytes > MAX_STDOUT_FRAME_BYTES
  ) {
    const last = chunk.pop()!;
    writeBatchChunk(chunk, false, undefined);
    chunk = [last];
    chunkFrameBytes = emptyFrameBytes + lastUpdateBytes;
  }

  if (chunkFrameBytes + stateBytes > MAX_STDOUT_FRAME_BYTES) {
    writeBatchChunk(chunk, false, undefined);
    writeBatchChunk([], true, state);
    return;
  }

  writeBatchChunk(chunk, hasState, state);
}

export function batchMessage(result: PollResultLike): RunnerMessage {
  if (Object.prototype.hasOwnProperty.call(result, "state")) {
    return {
      type: "batch",
      updates: result.updates,
      state: result.state as JsonValue,
    };
  }
  return { type: "batch", updates: result.updates };
}

function writeBatchChunk(
  updates: WireDocUpdate[],
  hasState: boolean,
  state: JsonValue | undefined,
): void {
  const frame = encoder.encode(
    encodeRunnerMessage(
      hasState ? batchMessage({ updates, state }) : batchMessage({ updates }),
    ),
  );
  if (frame.byteLength > MAX_STDOUT_FRAME_BYTES) {
    throw new Error("Deno poll result state exceeds IPC frame size limit");
  }
  writeFrame(frame);
}

function batchFrameBytes(
  updates: WireDocUpdate[],
  hasState: boolean,
  state: JsonValue | undefined,
): number {
  return encoder.encode(
    encodeRunnerMessage(
      hasState ? batchMessage({ updates, state }) : batchMessage({ updates }),
    ),
  ).byteLength;
}

/** Write one encoded frame, retrying short writes. */
function writeFrame(bytes: Uint8Array): void {
  const stdout = getDeno().stdout;
  const writeSync = stdout?.writeSync;
  if (typeof writeSync !== "function") {
    throw new Error("Deno stdout is unavailable");
  }
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync.call(stdout, bytes.subarray(offset));
    if (written <= 0) {
      throw new Error("Deno stdout write made no progress");
    }
    offset += written;
  }
}

export function errorMessage(error: unknown): RunnerMessage {
  if (error instanceof Error) {
    const permission = permissionDenial(error);
    return {
      type: "error",
      message: redactString(error.message),
      stack: error.stack === undefined ? undefined : redactString(error.stack),
      ...(permission && { permission }),
    };
  }
  return { type: "error", message: redactString(String(error)) };
}

/**
 * The sandbox denial behind `error`, found on it or its `cause` chain:
 * `Deno.errors.NotCapable`, or the `TypeError` fetch throws when DNS
 * resolution is denied.
 */
function permissionDenial(error: Error): PermissionDenial | undefined {
  const notCapable = getDeno().errors?.NotCapable;
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current instanceof Error;
    depth++
  ) {
    const denied =
      (notCapable !== undefined && current instanceof notCapable) ||
      (current instanceof TypeError &&
        current.message.includes("Requires net access"));
    const match = denied ? permissionDenialPattern.exec(current.message) : null;
    if (match && Object.hasOwn(DENIED_PERMISSIONS, match[1])) {
      return {
        kind: match[1] as DeniedPermission,
        // Code points, so a surrogate pair is never split.
        target: Array.from(redactString(match[2]))
          .slice(0, MAX_PERMISSION_TARGET_CHARS)
          .join(""),
      };
    }
    current = current.cause;
  }
  return undefined;
}

export function pollDoneMessage(): RunnerMessage {
  return { type: "poll_done" };
}

export function setConsoleRedactionConfig(
  config: Record<string, unknown>,
): void {
  collectSensitiveValues(config);
}

export function installConsoleLogRedirect(): void {
  if (installed) {
    return;
  }
  installed = true;

  console.debug = (...args: unknown[]) => writeLog("debug", args);
  console.log = (...args: unknown[]) => writeLog("info", args);
  console.info = (...args: unknown[]) => writeLog("info", args);
  console.warn = (...args: unknown[]) => writeLog("warn", args);
  console.error = (...args: unknown[]) => writeLog("error", args);
}

function writeLog(level: RunnerLogLevel, args: unknown[]): void {
  writeRunnerMessage({
    type: "log",
    level,
    message: redactString(formatConsoleArgs(args)),
  });
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => formatConsoleArg(redactValue(arg))).join(" ");
}

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  const inspect = getDeno().inspect;
  if (typeof inspect === "function") {
    return inspect(arg, { depth: 4 });
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKeyPattern.test(key)) {
    return "[redacted]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [
          entryKey,
          redactValue(entryValue, entryKey),
        ],
      ),
    );
  }

  return value;
}

function collectSensitiveValues(value: unknown, key?: string): void {
  if (
    key !== undefined &&
    sensitiveKeyPattern.test(key) &&
    typeof value === "string" &&
    value
  ) {
    sensitiveValues.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveValues(item);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (
      const [entryKey, entryValue] of Object.entries(
        value as Record<string, unknown>,
      )
    ) {
      collectSensitiveValues(entryValue, entryKey);
    }
  }
}

function redactString(message: string): string {
  let redacted = message;
  for (const value of sensitiveValues) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function getDeno(): DenoLike {
  return (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno ?? {};
}

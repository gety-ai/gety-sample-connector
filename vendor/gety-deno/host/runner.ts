import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Connector, PollResult } from "@gety-ai/connector-sdk";
import {
  errorMessage,
  installConsoleLogRedirect,
  pollDoneMessage,
  setConsoleRedactionConfig,
  writePollResultMessages,
  writeRunnerMessage,
} from "../sdk/src/ipc.ts";
import { readStartFrame } from "./start_frame.ts";

// Must match libs/gety-deno-connectors/src/runtime.rs
// `DENO_CONNECTOR_PROTOCOL_VERSION`. Exact string equality only — no SemVer
// negotiation and no tolerance for unknown versions.
// Keep in sync: libs/gety-deno-connectors/tests/protocol_version_sync.rs
const BUNDLED_PROTOCOL_VERSION = "0.2.0";
// How long a poll may run between event-loop turns that let a pending cancel
// (stdin EOF, SIGTERM) be observed. This gives periodic opportunities to see
// cancel between poll results, not a wall-clock guarantee: a single long
// `poll().next()` still runs to completion, and the host's forced kill after
// its cancel grace remains the backstop. Costs at most one ~1 ms timer turn per
// interval.
const CANCEL_CHECK_INTERVAL_MS = 100;

installConsoleLogRedirect();

type ConnectorConstructor = new () => Connector;

type ConnectorInternals = Connector & {
  config: Record<string, unknown>;
  lastState: unknown | null;
  signal: AbortSignal;
  dataDir: string;
  homeDir: string;
};

let exiting = false;

globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  exitWithError(event.reason);
});

globalThis.addEventListener("error", (event) => {
  event.preventDefault();
  exitWithError(event.error ?? event.message);
});

try {
  const startFrame = await readStartFrame();
  assertProtocolVersion(startFrame.protocol_version);

  const [connectorRoot, entryRel] = Deno.args;
  if (connectorRoot === undefined || entryRel === undefined) {
    throw new Error("usage: runner.ts CONNECTOR_ROOT ENTRY_REL");
  }
  const config = expectConfigObject(startFrame.config);

  setConsoleRedactionConfig(config);

  const controller = new AbortController();
  // Cross-platform primary cancel contract: host closes stdin after StartFrame
  // is written; stdin EOF aborts the connector SDK signal. Unix SIGTERM remains
  // a best-effort fallback for runners stuck before the EOF watcher starts.
  watchStdinEof(controller);
  try {
    Deno.addSignalListener("SIGTERM", () => {
      controller.abort();
    });
  } catch {
    // Windows and some restricted environments cannot install signal listeners.
  }

  // If cancel arrived before user code load, exit without import side effects.
  if (controller.signal.aborted) {
    Deno.exit(0);
  }

  // Protocol version is validated above so a mismatch fails before user code
  // is loaded or executed.
  const entryPath = join(connectorRoot, entryRel);
  const module = await import(pathToFileURL(entryPath).href);
  if (controller.signal.aborted) {
    Deno.exit(0);
  }

  const ConnectorClass = module.default as ConnectorConstructor | undefined;
  if (typeof ConnectorClass !== "function") {
    throw new Error("connector entry must default-export a Connector class");
  }

  const instance = new ConnectorClass();
  const internals = instance as ConnectorInternals;
  internals.config = config;
  internals.lastState = startFrame.last_state;
  internals.signal = controller.signal;
  internals.dataDir = startFrame.data_dir;
  internals.homeDir = startFrame.home_dir;

  if (controller.signal.aborted) {
    Deno.exit(0);
  }

  await instance.onLoad?.();
  if (controller.signal.aborted) {
    Deno.exit(0);
  }

  let lastCancelCheck = performance.now();
  for await (const result of instance.poll()) {
    // A poll that never awaits real I/O resumes through microtasks only, and
    // the stdin-EOF watcher and SIGTERM listener only run once the runtime
    // polls I/O. Without this turn the host's cancel goes unobserved until the
    // poll ends. A timer is required: it parks the runtime, which polls I/O,
    // while an immediate keeps it busy and can defer I/O for many turns.
    if (performance.now() - lastCancelCheck >= CANCEL_CHECK_INTERVAL_MS) {
      await sleep(0);
      lastCancelCheck = performance.now();
    }
    if (controller.signal.aborted) {
      break;
    }
    writePollResultMessages(result as PollResult);
  }

  if (controller.signal.aborted) {
    // Cooperative cancel: exit without poll_done so the host records Cancelled
    // rather than a successful completion.
    Deno.exit(0);
  }

  writeRunnerMessage(pollDoneMessage());
  Deno.exit(0);
} catch (error) {
  exitWithError(error);
}

/**
 * Continue reading stdin until EOF, then abort. Any residual bytes after the
 * StartFrame line are discarded; only EOF is meaningful.
 */
function watchStdinEof(controller: AbortController): void {
  void (async () => {
    try {
      const chunk = new Uint8Array(1024);
      while (true) {
        const read = await Deno.stdin.read(chunk);
        if (read === null) {
          controller.abort();
          return;
        }
      }
    } catch {
      // Closed/broken stdin is treated as cancel.
      controller.abort();
    }
  })();
}

function assertProtocolVersion(version: unknown): void {
  if (typeof version !== "string" || version !== BUNDLED_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported connector protocol_version: expected ${BUNDLED_PROTOCOL_VERSION}, got ${
        typeof version === "string" ? version : String(version)
      }`,
    );
  }
}

function expectConfigObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("start frame config must be an object");
  }
  return value as Record<string, unknown>;
}

function exitWithError(error: unknown): never {
  if (!exiting) {
    exiting = true;
    writeRunnerMessage(errorMessage(error));
  }
  Deno.exit(1);
}

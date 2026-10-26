import type { WireDocUpdate } from "./types.ts";

export type DocUpdate = WireDocUpdate;

export type PollResult = {
  updates: DocUpdate[];
  state?: unknown;
};

export abstract class Connector<
  Config extends object = Record<string, unknown>,
  State = unknown,
> {
  protected config: Config = {} as Config;
  protected lastState: State | null = null;
  protected signal: AbortSignal = new AbortController().signal;
  /** Absolute path of this connector's persistent data directory. */
  protected dataDir = "";
  /**
   * Absolute path of the user's home directory, as Gety resolves `~` in
   * `permissions.read`. Environment variables such as `HOME` are not
   * readable inside the sandbox.
   */
  protected homeDir = "";

  onLoad?(): void | Promise<void>;

  abstract poll(): AsyncGenerator<PollResult, void, unknown>;

  /**
   * Resolve a leading `~` against {@link homeDir}, matching how Gety grants
   * `~` entries in `permissions.read`. Other paths are returned unchanged.
   */
  protected expandHome(path: string): string {
    return expandHome(path, this.homeDir, Deno.build.os === "windows");
  }
}

/** {@link Connector.expandHome} with the platform made explicit for tests. */
export function expandHome(
  path: string,
  homeDir: string,
  windows: boolean,
): string {
  if (path === "~") {
    return homeDir;
  }
  const separators = windows ? /[\\/]/ : /\//;
  if (!path.startsWith("~") || !separators.test(path[1] ?? "")) {
    return path;
  }
  const separator = windows ? "\\" : "/";
  const rest = path.slice(2).split(separators).filter((segment) =>
    segment !== ""
  );
  return [homeDir.replace(/[\\/]+$/, ""), ...rest].join(separator);
}

import type { WireDoc, WireDocUpdate } from "./types.ts";

export function upsert(doc: WireDoc): WireDocUpdate {
  return { kind: "upsert", doc } satisfies WireDocUpdate;
}

export function del(id: string): WireDocUpdate {
  return { kind: "delete", id } satisfies WireDocUpdate;
}

import {type Claim, type ReplayStore, type SealedResponse, CLAIM_WINDOW_MS, ENTRY_LIFETIME_MS} from "../src/replayStore";

type Entry =
  | {state: "pending"; at: number; lease: string}
  | {state: "done"; at: number; sealed: SealedResponse; issued: string | undefined};

/**
 * The replay store held in memory, for tests. It makes the same decisions as
 * the Firestore one; test/replayStoreContract.ts runs against both to keep it
 * that way.
 */
export function memoryReplayStore(): ReplayStore & {entries: Map<string, Entry>} {
  const entries = new Map<string, Entry>();
  let leases = 0;
  const stored = (entry: Entry | undefined, now: number) =>
    entry?.state === "done" && now - entry.at < ENTRY_LIFETIME_MS ? {sealed: entry.sealed, storedAt: entry.at} : undefined;

  return {
    entries,
    async read(id, now) {
      return stored(entries.get(id), now);
    },
    async claim(id, now): Promise<Claim> {
      const entry = entries.get(id);
      const response = stored(entry, now);
      if (response !== undefined) return {outcome: "stored", response};
      if (entry?.state === "pending" && now - entry.at < CLAIM_WINDOW_MS) return {outcome: "in_progress"};
      const lease = `lease-${++leases}`;
      entries.set(id, {state: "pending", at: now, lease});
      return {outcome: "claimed", lease};
    },
    async complete(id, sealed, issued, now) {
      entries.set(id, {state: "done", at: now, sealed, issued});
    },
    async release(id, lease) {
      const entry = entries.get(id);
      if (entry?.state === "pending" && entry.lease === lease) entries.delete(id);
    },
    async issuedBy(issued, now) {
      for (const [id, entry] of entries) {
        if (entry.state === "done" && entry.issued === issued) {
          const response = stored(entry, now);
          return response === undefined ? undefined : {id, storedAt: response.storedAt};
        }
      }
      return undefined;
    },
    async remove(id) {
      entries.delete(id);
    },
  };
}

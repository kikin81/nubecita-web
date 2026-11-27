import {randomUUID} from "node:crypto";
import {expect, it} from "vitest";
import {type ReplayStore, type SealedResponse, CLAIM_WINDOW_MS, ENTRY_LIFETIME_MS} from "../src/replayStore";
import {START as NOW} from "./proofs";

const sealed = (): SealedResponse => ({
  salt: Buffer.from(randomUUID()),
  iv: Buffer.from("123456789012"),
  ciphertext: Buffer.from(`sealed-${randomUUID()}`),
});
const bytes = (response: {sealed: SealedResponse} | undefined) =>
  response === undefined
    ? undefined
    : [response.sealed.salt, response.sealed.iv, response.sealed.ciphertext].map((part) => Buffer.from(part).toString("hex"));

/**
 * What every replay store must do. Run against the in-memory store and, with
 * the Firestore emulator, against the real one, so tests that use the former
 * say something about the latter.
 */
export function replayStoreContract(store: () => ReplayStore): void {
  const fresh = (): string => randomUUID().replaceAll("-", "");

  it("lets one attempt forward and holds a second one back", async () => {
    const id = fresh();

    expect(await store().claim(id, NOW)).toMatchObject({outcome: "claimed"});
    expect(await store().claim(id, NOW + 1)).toEqual({outcome: "in_progress"});
    expect(await store().read(id, NOW + 1)).toBeUndefined();
  });

  it("tells exactly one of several simultaneous attempts to forward", async () => {
    const id = fresh();

    const claims = await Promise.all(Array.from({length: 6}, () => store().claim(id, NOW)));

    expect(claims.filter((claim) => claim.outcome === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === "in_progress")).toHaveLength(5);
  });

  it("holds a claim for a minute and lets it be taken over only after that", async () => {
    const id = fresh();
    const first = await store().claim(id, NOW);

    expect(await store().claim(id, NOW + CLAIM_WINDOW_MS - 1)).toEqual({outcome: "in_progress"});
    const taken = await store().claim(id, NOW + CLAIM_WINDOW_MS);

    expect(taken).toMatchObject({outcome: "claimed"});
    expect(taken).not.toEqual(first);
    // The window starts again for the attempt that took over.
    expect(await store().claim(id, NOW + CLAIM_WINDOW_MS + 1)).toEqual({outcome: "in_progress"});
  });

  it("frees a refresh token when its claim is given back", async () => {
    const id = fresh();
    const claim = await store().claim(id, NOW);
    if (claim.outcome !== "claimed") throw new Error("expected a claim");

    await store().release(id, claim.lease);

    expect(await store().claim(id, NOW + 1)).toMatchObject({outcome: "claimed"});
  });

  it("ignores an attempt giving back a claim that is no longer its own", async () => {
    const id = fresh();
    const first = await store().claim(id, NOW);
    const second = await store().claim(id, NOW + CLAIM_WINDOW_MS);
    if (first.outcome !== "claimed" || second.outcome !== "claimed") throw new Error("expected claims");

    await store().release(id, first.lease);
    expect(await store().claim(id, NOW + CLAIM_WINDOW_MS + 1)).toEqual({outcome: "in_progress"});

    await store().release(fresh(), "no-such-lease");
  });

  it("returns a recorded response, byte for byte, to a read and to a claim", async () => {
    const id = fresh();
    const response = sealed();
    await store().claim(id, NOW);

    await store().complete(id, response, "mark", NOW + 5);

    const read = await store().read(id, NOW + 6);
    expect(read?.storedAt).toBe(NOW + 5);
    expect(bytes(read)).toEqual(bytes({sealed: response}));
    const claim = await store().claim(id, NOW + 6);
    expect(claim.outcome).toBe("stored");
    expect(bytes(claim.outcome === "stored" ? claim.response : undefined)).toEqual(bytes({sealed: response}));
  });

  it("keeps a recorded response when a stale claim is given back afterwards", async () => {
    const id = fresh();
    const claim = await store().claim(id, NOW);
    if (claim.outcome !== "claimed") throw new Error("expected a claim");
    await store().complete(id, sealed(), undefined, NOW);

    await store().release(id, claim.lease);

    expect(await store().read(id, NOW)).toBeDefined();
  });

  it("stops returning a response 24 hours after it was recorded, and lets the token be forwarded again", async () => {
    const id = fresh();
    await store().complete(id, sealed(), "mark-expiring", NOW);

    expect(await store().read(id, NOW + ENTRY_LIFETIME_MS - 1)).toBeDefined();
    expect(await store().read(id, NOW + ENTRY_LIFETIME_MS)).toBeUndefined();
    expect(await store().claim(id, NOW + ENTRY_LIFETIME_MS)).toMatchObject({outcome: "claimed"});
  });

  it("finds the entry that issued a refresh token, until it is removed or expires", async () => {
    const id = fresh();
    const mark = fresh();
    await store().complete(id, sealed(), mark, NOW);

    expect(await store().issuedBy(mark, NOW + 1000)).toEqual({id, storedAt: NOW});
    expect(await store().issuedBy(fresh(), NOW + 1000)).toBeUndefined();
    expect(await store().issuedBy(mark, NOW + ENTRY_LIFETIME_MS)).toBeUndefined();

    await store().remove(id);

    expect(await store().issuedBy(mark, NOW + 1000)).toBeUndefined();
    expect(await store().read(id, NOW + 1000)).toBeUndefined();
    await store().remove(id);
  });
}

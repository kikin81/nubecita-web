import {randomUUID} from "node:crypto";
import {afterAll, describe, expect, it} from "vitest";
import {START} from "../proofs";
import {replayStoreContract} from "../replayStoreContract";
import {DOCUMENTS, emulatedStores, rawDocument} from "./firestore";

const {store, otherStore, close} = emulatedStores();
afterAll(close);

describe("the Firestore replay store", () => {
  replayStoreContract(() => store);

  it("tells exactly one of several simultaneous attempts on different instances to forward", async () => {
    const id = randomUUID();

    const claims = await Promise.all([store, otherStore, store, otherStore].map((each) => each.claim(id, START)));

    expect(claims.filter((claim) => claim.outcome === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === "in_progress")).toHaveLength(3);
  });
});

describe("the security rules", () => {
  // No Authorization header: what an app or a browser holding only the
  // project's public API key can do.
  it("refuse a client every read", async () => {
    const id = randomUUID();
    await store.complete(id, {salt: Buffer.from("salt"), iv: Buffer.from("iv"), ciphertext: Buffer.from("sealed")}, undefined, START);
    expect(await rawDocument(id)).toContain("ciphertext");

    const one = await fetch(`${DOCUMENTS}/${id}`);
    const list = await fetch(DOCUMENTS);

    expect(one.status).toBe(403);
    expect(list.status).toBe(403);
    expect(await one.text()).not.toContain("ciphertext");
  });

  it("refuse a client every write", async () => {
    const id = randomUUID();

    const created = await fetch(`${DOCUMENTS}?documentId=${id}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({fields: {state: {stringValue: "done"}}}),
    });
    const removed = await fetch(`${DOCUMENTS}/${id}`, {method: "DELETE"});

    expect(created.status).toBe(403);
    expect(removed.status).toBe(403);
    expect(await store.read(id, START)).toBeUndefined();
  });
});

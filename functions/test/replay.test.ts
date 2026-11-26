import {describe, expect, it} from "vitest";
import type {ReplayStore} from "../src/replayStore";
import {ORIGIN_HEADER, REPLAYED_HEADER} from "../src/responses";
import {DPOP, REFRESH_TOKEN, dpopProof, harness, json, post, refresh, tokenTraces} from "./harness";
import {memoryReplayStore} from "./memoryReplayStore";
import {newToken, replayScenarios, tokens} from "./replayScenarios";

describe("replay-safe refresh", () => {
  replayScenarios(memoryReplayStore);
});

/** A store in which the named operations fail, or never finish. */
function failing(operations: Array<keyof ReplayStore>, how: "throws" | "hangs" = "throws"): ReplayStore {
  const store = memoryReplayStore();
  const broken = (): Promise<never> =>
    how === "throws" ? Promise.reject(new Error("firestore unavailable")) : new Promise<never>(() => undefined);
  return {...store, ...Object.fromEntries(operations.map((operation) => [operation, broken]))};
}

describe("when the replay store fails", () => {
  it.each([["throws"], ["hangs"]] as const)("still relays a successful refresh when recording it %s", async (how) => {
    const body = tokens();
    const h = harness({replayStore: failing(["complete"], how), storeTimeoutMs: 25, upstream: [() => json(200, body)]});

    const response = await h.handle(refresh());

    expect(response.status).toBe(200);
    expect(response.headers[ORIGIN_HEADER]).toBe("upstream");
    expect(JSON.parse(response.body)).toEqual(body);
    expect(h.logs[0]).toMatchObject({status: 200, origin: "upstream", forwarded: true, replayed: false, replayStore: "write_failed"});
  });

  it("still relays an error when giving the claim back fails", async () => {
    const h = harness({replayStore: failing(["release"]), upstream: [() => json(400, {error: "use_dpop_nonce"})]});

    const response = await h.handle(refresh());

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({error: "use_dpop_nonce"});
    expect(h.logs[0]).toMatchObject({origin: "upstream", replayStore: "write_failed"});
  });

  it("still forwards when a superseded entry cannot be removed", async () => {
    const store = memoryReplayStore();
    const second = tokens();
    const h = harness({
      replayStore: {...store, remove: () => Promise.reject(new Error("firestore unavailable"))},
      upstream: [() => json(200, second), () => json(200, tokens())],
    });
    await h.handle(refresh());

    const response = await h.handle(refresh({}, second.refresh_token));

    expect(response.status).toBe(200);
    expect(h.logs[1]).toMatchObject({forwarded: true, replayStore: "write_failed"});
  });

  // Unable to tell whether the token is spent or in flight, the backend must
  // not forward it: a retry is cheap and a replayed token is not.
  it.each([
    ["look up the refresh token", ["read"]],
    ["look up what issued it", ["issuedBy"]],
    ["claim it", ["claim"]],
  ] as const)("refuses a refresh, without forwarding it, when it cannot %s", async (_label, operations) => {
    for (const how of ["throws", "hangs"] as const) {
      const h = harness({replayStore: failing([...operations], how), storeTimeoutMs: 25, upstream: [() => json(200, tokens())]});

      const response = await h.handle(refresh());

      expect(response.status).toBe(500);
      expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
      expect(JSON.parse(response.body)).toEqual({error: "mediator_internal", forwarded: false});
      expect(h.upstreamRequests).toHaveLength(0);
      expect(h.logs[0]).toMatchObject({reason: "internal", forwarded: false, replayStore: "unavailable"});
    }
  });

  it("in bypass mode answers 'go direct' when the store cannot be read", async () => {
    const h = harness({replayStore: failing(["read"]), settings: {bypass: true}});

    const response = await h.handle(refresh());

    expect(JSON.parse(response.body)).toEqual({error: "mediator_bypass", forwarded: false});
    expect(h.logs[0]).toMatchObject({reason: "bypass", replayStore: "unavailable"});
  });

  it("refuses to serve an entry that cannot be decrypted, rather than forward a spent token", async () => {
    const store = memoryReplayStore();
    const h = harness({replayStore: store, upstream: [() => json(200, tokens())]});
    await h.handle(refresh());
    for (const entry of store.entries.values()) {
      if (entry.state === "done") entry.sealed = {...entry.sealed, ciphertext: Buffer.from("corrupted ciphertext, long enough")};
    }

    const response = await h.handle(refresh());

    expect(JSON.parse(response.body)).toEqual({error: "mediator_bad_request", forwarded: false});
    expect(h.upstreamRequests).toHaveLength(1);
  });
});

describe("what the replay store is used for", () => {
  it("is never touched by a sign-in, a code exchange or a sign-out", async () => {
    const store = memoryReplayStore();
    const ok = () => json(200, tokens());
    const h = harness({replayStore: store, upstream: [ok, ok, ok, ok, ok]});
    const exchange = () => post("/token", {grant_type: "authorization_code", code: "cod-1", code_verifier: "v"});

    await h.handle(post("/par", {response_type: "code"}));
    await h.handle(exchange());
    await h.handle(exchange());
    await h.handle(post("/revoke", {token: REFRESH_TOKEN}));
    await h.handle(post("/revoke", {token: REFRESH_TOKEN}));

    expect(h.upstreamRequests).toHaveLength(5);
    expect(store.entries.size).toBe(0);
    expect(h.logs.every((entry) => !entry.replayed && entry.replayStore === undefined)).toBe(true);
  });

  it("forwards a refresh that carries no refresh token as it is, and stores nothing", async () => {
    const store = memoryReplayStore();
    const h = harness({replayStore: store, upstream: [() => json(400, {error: "invalid_request"})]});

    const response = await h.handle(post("/token", {grant_type: "refresh_token"}));

    expect(response.status).toBe(400);
    expect(store.entries.size).toBe(0);
  });

  it("stores nothing for a refresh whose accepted proof it cannot read", async () => {
    const store = memoryReplayStore();
    const h = harness({replayStore: store, upstream: [() => json(200, tokens())]});

    const response = await h.handle(refresh({dpop: "eyJ0eXAiOiJkcG9wK2p3dCJ9.e30.c2ln"}));

    expect(response.status).toBe(200);
    expect(h.logs[0]).toMatchObject({replayStore: "write_failed"});
    expect([...store.entries.values()].every((entry) => entry.state === "pending")).toBe(true);
  });
});

describe("what replay-safe refresh leaves behind", () => {
  it("puts no part of any token in the store or in the log", async () => {
    const store = memoryReplayStore();
    const first = newToken();
    const second = tokens();
    const third = tokens();
    const h = harness({
      replayStore: store,
      upstream: [() => json(200, second), () => json(401, {error: "use_dpop_nonce"}), () => json(200, third)],
    });
    const proofs = [0, 1, 2, 3, 4].map(() => dpopProof());

    await h.handle(refresh({dpop: proofs[0]}, first));
    await h.handle(refresh({dpop: proofs[1]}, first));
    await h.handle(refresh({dpop: proofs[2]}, second.refresh_token));
    await h.handle(refresh({dpop: proofs[3]}, second.refresh_token));
    const replayedAnswer = await h.handle(refresh({dpop: proofs[4]}, second.refresh_token));
    expect(replayedAnswer.headers[REPLAYED_HEADER]).toBe("1");
    expect(h.logs.map((entry) => entry.replayed)).toEqual([false, true, false, false, true]);

    const secrets = [first, second.refresh_token, second.access_token, third.refresh_token, third.access_token, DPOP, ...proofs];
    const kept = [...store.entries].map(([id, entry]) =>
      entry.state === "pending"
        ? JSON.stringify([id, entry])
        : [id, entry.issued, entry.at].join(" ") +
          [entry.sealed.salt, entry.sealed.iv, entry.sealed.ciphertext]
            .flatMap((part) => ["latin1", "base64", "base64url", "hex"].map((encoding) => Buffer.from(part).toString(encoding as BufferEncoding)))
            .join(" "),
    );
    expect(kept).toHaveLength(1);
    expect(tokenTraces(kept.join("\n"), secrets)).toEqual([]);
    expect(tokenTraces(JSON.stringify(h.logs), [...secrets, "did:plc:alice1234567890"])).toEqual([]);
  });
});

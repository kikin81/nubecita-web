import {expect, it} from "vitest";
import {PROOF_MAX_AGE_MS} from "../src/dpop";
import {NotSentError, OutcomeUnknownError, type OutboundResponse} from "../src/outbound";
import {type ReplayStore, CLAIM_WINDOW_MS, ENTRY_LIFETIME_MS} from "../src/replayStore";
import {AUTH_METHOD_HEADER, KID_HEADER, ORIGIN_HEADER, REPLAYED_HEADER, UPSTREAM_DATE_HEADER} from "../src/responses";
import {type Upstream, deviceKey, dpopProof, harness, json, refresh} from "./harness";
import {newToken} from "./proofs";

export {newToken};

/** A successful refresh response that hands out `refreshToken`. */
export function tokens(refreshToken: string = newToken()) {
  return {
    access_token: newToken("at"),
    refresh_token: refreshToken,
    token_type: "DPoP",
    expires_in: 3600,
    sub: "did:plc:alice1234567890",
  };
}

const error = (response: {body: string}): unknown => JSON.parse(response.body);
const IN_PROGRESS = {error: "mediator_in_progress", forwarded: "unknown"};
const invalidGrant: Upstream = () => json(400, {error: "invalid_grant", error_description: "refresh token replayed"});

/**
 * Replay-safe refresh, end to end through the mediator. Run with the
 * in-memory store and, in the emulator suite, with the Firestore one.
 */
export function replayScenarios(newStore: () => ReplayStore): void {
  /** A refresh with a proof made at the harness's current time. */
  const attempt = (h: ReturnType<typeof harness>, token: string, headers: Record<string, string | undefined> = {}) =>
    h.handle(refresh({dpop: dpopProof({atMs: h.now()}), ...headers}, token));

  it("answers a retry of a refresh whose response was lost, without asking the authorization server again", async () => {
    const token = newToken();
    const body = tokens();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, body, {"dpop-nonce": "nonce-7"})]});

    const lost = await attempt(h, token);
    h.advance(20_000);
    const retried = await attempt(h, token);

    expect(retried.status).toBe(200);
    expect(retried.body).toBe(lost.body);
    expect(JSON.parse(retried.body)).toEqual(body);
    expect(retried.headers[REPLAYED_HEADER]).toBe("1");
    expect(retried.headers[ORIGIN_HEADER]).toBe("upstream");
    expect(retried.headers[KID_HEADER]).toBe("test-2");
    expect(retried.headers[AUTH_METHOD_HEADER]).toBe("private_key_jwt");
    expect(retried.headers["DPoP-Nonce"]).toBe("nonce-7");
    expect(retried.headers["Content-Type"]).toBe("application/json");
    expect(retried.headers["Cache-Control"]).toBe("no-store");
    // The app sets its clock by this header; a stored answer's date is stale.
    expect(retried.headers).not.toHaveProperty(UPSTREAM_DATE_HEADER);
    expect(lost.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(h.upstreamRequests).toHaveLength(1);
    expect(h.logs[1]).toMatchObject({kind: "refresh", status: 200, origin: "upstream", forwarded: false, replayed: true});
    expect(h.logs[0]).toMatchObject({forwarded: true, replayed: false});
  });

  it("answers the retry on whichever instance it lands", async () => {
    const store = newStore();
    const token = newToken();
    const body = tokens();
    const first = harness({replayStore: store, upstream: [() => json(200, body)]});
    const second = harness({replayStore: store});

    await attempt(first, token);
    const retried = await attempt(second, token);

    expect(JSON.parse(retried.body)).toEqual(body);
    expect(retried.headers[REPLAYED_HEADER]).toBe("1");
    expect(second.allRequests).toHaveLength(0);
  });

  it("reports the key that actually signed the original refresh", async () => {
    const token = newToken();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, tokens())]});

    await attempt(h, token, {"nubecita-client-auth-kid": "test-1"});
    const retried = await attempt(h, token);

    expect(retried.headers[KID_HEADER]).toBe("test-1");
  });

  it("forwards one of two simultaneous identical refreshes and holds the other back", async () => {
    const token = newToken();
    const body = tokens();
    let answer: (response: OutboundResponse) => void = () => undefined;
    let reached: () => void = () => undefined;
    const upstreamReached = new Promise<void>((resolve) => (reached = resolve));
    const h = harness({
      replayStore: newStore(),
      upstream: [
        () =>
          new Promise<OutboundResponse>((resolve) => {
            answer = resolve;
            reached();
          }),
      ],
    });

    const both = [attempt(h, token), attempt(h, token)];
    await upstreamReached;
    // Whichever lost the race has been told so before the winner is answered.
    const heldBack = await Promise.race(both);
    answer(json(200, body));
    const responses = await Promise.all(both);

    expect(h.upstreamRequests).toHaveLength(1);
    expect(heldBack.status).toBe(409);
    expect(heldBack.headers[ORIGIN_HEADER]).toBe("mediator");
    // The other attempt may already have spent the token.
    expect(error(heldBack)).toEqual(IN_PROGRESS);
    const forwarded = responses.find((response) => response !== heldBack)!;
    expect(JSON.parse(forwarded.body)).toEqual(body);

    // And when the one held back tries again, it gets the same answer.
    const retried = await attempt(h, token);
    expect(JSON.parse(retried.body)).toEqual(body);
    expect(retried.headers[REPLAYED_HEADER]).toBe("1");
    expect(h.upstreamRequests).toHaveLength(1);
  });

  it("does not hold back the retry that follows a nonce challenge", async () => {
    const token = newToken();
    const body = tokens();
    const h = harness({
      replayStore: newStore(),
      upstream: [() => json(400, {error: "use_dpop_nonce"}, {"dpop-nonce": "nonce-1"}), () => json(200, body)],
    });

    const challenged = await attempt(h, token);
    const retried = await attempt(h, token);

    expect(error(challenged)).toEqual({error: "use_dpop_nonce"});
    expect(challenged.headers["DPoP-Nonce"]).toBe("nonce-1");
    expect(challenged.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(JSON.parse(retried.body)).toEqual(body);
    expect(retried.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it.each([
    ["an invalid_request", 400, {error: "invalid_request"}],
    ["an invalid_client", 401, {error: "invalid_client"}],
    ["a server error", 500, {error: "server_error"}],
    ["a redirect", 302, {}],
  ])("forwards the next attempt after %s, which consumed nothing", async (_label, status, body) => {
    const token = newToken();
    const h = harness({replayStore: newStore(), upstream: [() => json(status, body), () => json(200, tokens())]});

    expect((await attempt(h, token)).status).toBe(status);
    expect((await attempt(h, token)).status).toBe(200);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it("never stores an error: a rejected refresh is rejected again by the authorization server itself", async () => {
    const token = newToken();
    const h = harness({replayStore: newStore(), upstream: [invalidGrant, invalidGrant]});

    await attempt(h, token);
    const again = await attempt(h, token);

    expect(again.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it("holds retries back for a minute after an authorization server did not answer, then lets one through", async () => {
    const token = newToken();
    const body = tokens();
    const h = harness({
      replayStore: newStore(),
      upstream: [
        () => {
          throw new OutcomeUnknownError("timed out");
        },
        () => json(200, body),
      ],
    });

    expect(error(await attempt(h, token))).toEqual({error: "mediator_upstream_timeout", forwarded: "unknown"});

    h.advance(1_000);
    const soon = await attempt(h, token);
    h.advance(CLAIM_WINDOW_MS - 2_000);
    const stillSoon = await attempt(h, token);
    expect(error(soon)).toEqual(IN_PROGRESS);
    expect(error(stillSoon)).toEqual(IN_PROGRESS);
    expect(h.upstreamRequests).toHaveLength(1);
    expect(h.logs[1]).toMatchObject({origin: "mediator", reason: "in_progress", forwarded: "unknown", status: 409});

    h.advance(1_000);
    const later = await attempt(h, token);
    expect(JSON.parse(later.body)).toEqual(body);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it("holds retries back after an unexpected failure once the request had been sent", async () => {
    const token = newToken();
    const h = harness({
      replayStore: newStore(),
      upstream: [
        () => {
          throw new Error("something unforeseen");
        },
      ],
    });

    expect(error(await attempt(h, token))).toEqual({error: "mediator_internal", forwarded: "unknown"});
    expect(error(await attempt(h, token))).toEqual(IN_PROGRESS);
    expect(h.upstreamRequests).toHaveLength(1);
  });

  it("does not hold a retry back when the first attempt provably never left", async () => {
    const token = newToken();
    const h = harness({
      replayStore: newStore(),
      upstream: [
        () => {
          throw new NotSentError("connection refused");
        },
        () => json(200, tokens()),
      ],
    });

    expect(error(await attempt(h, token))).toEqual({error: "mediator_upstream_unreachable", forwarded: false});
    expect((await attempt(h, token)).status).toBe(200);
  });

  it("leaves nothing behind when a refresh is refused before it is forwarded", async () => {
    const token = newToken();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, tokens())]});

    const refused = await attempt(h, token, {"nubecita-issuer": "http://not-https.test"});
    const accepted = await attempt(h, token);

    expect(error(refused)).toEqual({error: "mediator_issuer_rejected", forwarded: false});
    expect(accepted.status).toBe(200);
  });

  for (const [label, proof] of [
    ["from another key", (at: number) => dpopProof({atMs: at, key: deviceKey()})],
    ["that is stale", (at: number) => dpopProof({atMs: at - PROOF_MAX_AGE_MS - 1_000})],
    ["dated in the future", (at: number) => dpopProof({atMs: at + PROOF_MAX_AGE_MS + 1_000})],
    ["for another endpoint", (at: number) => dpopProof({atMs: at, htu: "https://auth.test/oauth/par"})],
    ["for another method", (at: number) => dpopProof({atMs: at, htm: "GET"})],
    ["that is not a proof at all", () => "not.a.proof"],
  ] as const) {
    it(`gives a stored response to no one with a proof ${label}, and does not forward the spent token`, async () => {
      const token = newToken();
      const body = tokens();
      const h = harness({replayStore: newStore(), upstream: [() => json(200, body)]});
      await attempt(h, token);
      h.advance(30_000);

      const response = await h.handle(refresh({dpop: proof(h.now())}, token));

      expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
      expect(response.headers).not.toHaveProperty(REPLAYED_HEADER);
      expect(error(response)).toEqual({error: "mediator_bad_request", forwarded: false});
      expect(response.body).not.toContain(body.access_token);
      expect(response.body).not.toContain(body.refresh_token);
      // Forwarding a token known to be spent would delete the session.
      expect(h.upstreamRequests).toHaveLength(1);
      expect(h.logs[1]).toMatchObject({replayed: false, forwarded: false});

      // The rightful holder is still served afterwards.
      const rightful = await attempt(h, token);
      expect(JSON.parse(rightful.body)).toEqual(body);
    });
  }

  it("removes a stored response once the refresh token it handed out is used", async () => {
    const first = newToken();
    const second = tokens();
    const third = tokens();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, second), () => json(200, third), invalidGrant]});

    await attempt(h, first);
    const next = await attempt(h, second.refresh_token);
    expect(JSON.parse(next.body)).toEqual(third);
    expect(next.headers).not.toHaveProperty(REPLAYED_HEADER);

    // The first answer is gone, so the spent token is no longer answered from the store.
    const stale = await attempt(h, first);
    expect(stale.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(stale.headers[ORIGIN_HEADER]).toBe("upstream");
    expect(error(stale)).toMatchObject({error: "invalid_grant"});
    expect(h.upstreamRequests).toHaveLength(3);

    // The newest answer is still there.
    const retried = await attempt(h, second.refresh_token);
    expect(JSON.parse(retried.body)).toEqual(third);
    expect(retried.headers[REPLAYED_HEADER]).toBe("1");
  });

  it("keeps a stored response for 24 hours and not a moment longer", async () => {
    const token = newToken();
    const body = tokens();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, body), invalidGrant]});
    await attempt(h, token);

    h.advance(ENTRY_LIFETIME_MS - 1_000);
    const inTime = await attempt(h, token);
    expect(JSON.parse(inTime.body)).toEqual(body);
    expect(inTime.headers[REPLAYED_HEADER]).toBe("1");

    h.advance(1_000);
    const tooLate = await attempt(h, token);
    expect(tooLate.headers).not.toHaveProperty(REPLAYED_HEADER);
    expect(tooLate.body).not.toContain(body.access_token);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it("stores a response that hands out no new refresh token", async () => {
    const token = newToken();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, {access_token: "at-only"})]});

    await attempt(h, token);
    const retried = await attempt(h, token);

    expect(JSON.parse(retried.body)).toEqual({access_token: "at-only"});
    expect(retried.headers[REPLAYED_HEADER]).toBe("1");
  });

  it("holds a replay to the strict attestation setting like any other refresh", async () => {
    const store = newStore();
    const token = newToken();
    const body = tokens();
    await attempt(harness({replayStore: store, upstream: [() => json(200, body)]}), token);
    const strict = harness({replayStore: store, attestation: "missing", settings: {strictRefreshAttestation: true}});

    const response = await attempt(strict, token);

    expect(error(response)).toEqual({error: "mediator_attestation_required", forwarded: false});
    expect(response.body).not.toContain(body.access_token);
  });

  it("in bypass mode still answers a refresh it has a stored response for, and contacts no one", async () => {
    const token = newToken();
    const body = tokens();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, body)]});
    await attempt(h, token);
    const outboundBefore = h.allRequests.length;
    h.settings.bypass = true;

    const stored = await attempt(h, token);
    const unknown = await attempt(h, newToken());
    const wrongKey = await h.handle(refresh({dpop: dpopProof({atMs: h.now(), key: deviceKey()})}, token));
    const noProof = await h.handle(refresh({dpop: undefined}, token));

    expect(stored.status).toBe(200);
    expect(JSON.parse(stored.body)).toEqual(body);
    expect(stored.headers[REPLAYED_HEADER]).toBe("1");
    expect(stored.headers[ORIGIN_HEADER]).toBe("upstream");
    for (const response of [unknown, wrongKey, noProof]) {
      expect(response.status).toBe(503);
      expect(error(response)).toEqual({error: "mediator_bypass", forwarded: false});
    }
    expect(h.allRequests).toHaveLength(outboundBefore);
    expect(h.logs.at(-4)).toMatchObject({replayed: true, origin: "upstream", forwarded: false, attestation: "not_checked"});
    expect(h.logs.at(-3)).toMatchObject({replayed: false, reason: "bypass"});
  });

  it("with a minimum refresh interval, refuses to refresh a token it handed out too recently, without contacting anyone", async () => {
    const first = newToken();
    const second = tokens();
    const third = tokens();
    const h = harness({
      replayStore: newStore(),
      settings: {minRefreshIntervalMs: 30 * 60_000},
      upstream: [() => json(200, second), () => json(200, third)],
    });
    await attempt(h, first);
    const outboundBefore = h.allRequests.length;

    h.advance(5 * 60_000);
    const tooSoon = await attempt(h, second.refresh_token);

    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers[ORIGIN_HEADER]).toBe("mediator");
    expect(error(tooSoon)).toEqual({error: "mediator_rate_limited", forwarded: false});
    expect(h.allRequests).toHaveLength(outboundBefore);
    expect(h.logs.at(-1)).toMatchObject({reason: "rate_limited", forwarded: false, replayed: false});

    // The answer that handed the token out is kept while the token waits.
    const earlier = await attempt(h, first);
    expect(JSON.parse(earlier.body)).toEqual(second);
    expect(earlier.headers[REPLAYED_HEADER]).toBe("1");

    h.advance(25 * 60_000 - 1);
    expect((await attempt(h, second.refresh_token)).status).toBe(429);
    h.advance(1);
    const allowed = await attempt(h, second.refresh_token);
    expect(JSON.parse(allowed.body)).toEqual(third);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it("with the interval off, refreshes a token it handed out a moment ago", async () => {
    const second = tokens();
    const h = harness({replayStore: newStore(), upstream: [() => json(200, second), () => json(200, tokens())]});

    await attempt(h, newToken());
    const immediately = await attempt(h, second.refresh_token);

    expect(immediately.status).toBe(200);
    expect(h.upstreamRequests).toHaveLength(2);
  });

  it("with the interval on, still forwards a refresh token it has no record of handing out", async () => {
    const h = harness({
      replayStore: newStore(),
      settings: {minRefreshIntervalMs: 30 * 60_000},
      upstream: [() => json(200, tokens())],
    });

    expect((await attempt(h, newToken())).status).toBe(200);
  });
}

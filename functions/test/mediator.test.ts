import {describe, expect, it} from "vitest";
import {attestationVerifier} from "../src/attestation";
import {GuardError} from "../src/guard";
import type {MediatorRequest} from "../src/mediator";
import {NotSentError, OutcomeUnknownError} from "../src/outbound";
import {AUTH_METHOD_HEADER, KID_HEADER, ORIGIN_HEADER, UPSTREAM_DATE_HEADER} from "../src/responses";
import {
  type Upstream,
  CLIENT_ID,
  DPOP,
  ISSUER,
  METADATA,
  REFRESH_TOKEN,
  assertionOf,
  harness,
  json,
  par,
  post,
  refresh,
} from "./harness";

describe("routing", () => {
  it.each([
    ["GET", "/token"],
    ["POST", "/"],
    ["POST", "/xrpc/app.bsky.feed.getTimeline"],
    ["POST", "/token/extra"],
    ["PUT", "/par"],
  ])("answers %s %s with a backend-produced 404 and contacts no one", async (method, path) => {
    const h = harness();

    const response = await h.handle({...refresh(), method, path});

    expect(response.status).toBe(404);
    expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
    expect(JSON.parse(response.body)).toEqual({error: "mediator_not_found", forwarded: false});
    expect(h.allRequests).toHaveLength(0);
  });

  it("refuses a grant type it does not mediate", async () => {
    const h = harness();

    const response = await h.handle(post("/token", {grant_type: "client_credentials"}));

    expect(JSON.parse(response.body)).toEqual({error: "mediator_bad_request", forwarded: false});
    expect(h.allRequests).toHaveLength(0);
  });

  it.each([["dpop"], ["nubecita-issuer"]])("refuses a request without the %s header", async (header) => {
    const h = harness();

    const response = await h.handle(refresh({[header]: undefined}));

    expect(JSON.parse(response.body)).toEqual({error: "mediator_bad_request", forwarded: false});
    expect(h.upstreamRequests).toHaveLength(0);
  });
});

describe("forwarding", () => {
  it("sends each kind of request to the endpoint the issuer publishes for it", async () => {
    const ok: Upstream = () => json(200, {});
    const h = harness({upstream: [ok, ok, ok, ok]});

    await h.handle(par());
    await h.handle(post("/token", {grant_type: "authorization_code", code: "cod-1", code_verifier: "v"}));
    await h.handle(refresh());
    await h.handle(post("/revoke", {token: REFRESH_TOKEN}));

    expect(h.upstreamRequests.map((request) => request.url.href)).toEqual([
      `${ISSUER}/oauth/par`,
      `${ISSUER}/oauth/token`,
      `${ISSUER}/oauth/token`,
      `${ISSUER}/oauth/revoke`,
    ]);
    expect(h.upstreamRequests.every((request) => request.method === "POST")).toBe(true);
  });

  it("passes the form on unchanged, the DPoP proof byte for byte, and adds a valid client assertion", async () => {
    const h = harness({upstream: [() => json(200, {access_token: "at"})]});

    await h.handle(refresh());

    const sent = h.upstreamRequests[0]!;
    const {form, header, payload, verifies} = assertionOf(sent);
    expect(sent.headers["dpop"]).toBe(DPOP);
    expect(sent.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(header).toEqual({alg: "ES256", typ: "JWT", kid: "test-2"});
    expect(payload).toEqual({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: ISSUER,
      iat: 1_795_000_000,
      exp: 1_795_000_060,
      jti: "jti-1",
    });
    expect(verifies).toBe(true);
  });

  it("replaces any client assertion the caller tried to supply", async () => {
    const h = harness({upstream: [() => json(200, {})]});

    await h.handle(
      post("/token", {
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_assertion: "attacker.supplied.jwt",
        client_assertion_type: "something-else",
      }),
    );

    const form = new URLSearchParams(h.upstreamRequests[0]!.body);
    expect(form.getAll("client_assertion")).toHaveLength(1);
    expect(form.get("client_assertion")).not.toBe("attacker.supplied.jwt");
    expect(form.getAll("client_assertion_type")).toEqual(["urn:ietf:params:oauth:client-assertion-type:jwt-bearer"]);
  });

  it("relays status and body unchanged and marks the response as the authorization server's", async () => {
    const body = {access_token: "at_new", refresh_token: "ref-new", token_type: "DPoP", sub: "did:plc:alice"};
    const h = harness({upstream: [() => json(200, body, {"dpop-nonce": "nonce-2"})]});

    const response = await h.handle(refresh());

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(body);
    expect(response.headers[ORIGIN_HEADER]).toBe("upstream");
    expect(response.headers[KID_HEADER]).toBe("test-2");
    expect(response.headers[AUTH_METHOD_HEADER]).toBe("private_key_jwt");
    expect(response.headers["DPoP-Nonce"]).toBe("nonce-2");
    expect(response.headers[UPSTREAM_DATE_HEADER]).toBe("Wed, 25 Nov 2026 10:00:00 GMT");
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  it("relays the authorization server's invalid_grant exactly, marked as relayed", async () => {
    const h = harness({upstream: [() => json(400, {error: "invalid_grant", error_description: "Session expired"})]});

    const response = await h.handle(refresh());

    expect(response.status).toBe(400);
    expect(response.headers[ORIGIN_HEADER]).toBe("upstream");
    expect(JSON.parse(response.body)).toEqual({error: "invalid_grant", error_description: "Session expired"});
  });

  it("relays a nonce challenge and signs a fresh assertion for the retry", async () => {
    const h = harness({
      upstream: [() => json(400, {error: "use_dpop_nonce"}, {"dpop-nonce": "nonce-1"}), () => json(200, {})],
    });

    const challenged = await h.handle(refresh());
    await h.handle(refresh());

    expect(challenged.status).toBe(400);
    expect(challenged.headers["DPoP-Nonce"]).toBe("nonce-1");
    expect(JSON.parse(challenged.body)).toEqual({error: "use_dpop_nonce"});
    const [first, second] = h.upstreamRequests.map((request) => assertionOf(request));
    expect(first!.payload["jti"]).not.toBe(second!.payload["jti"]);
    expect(first!.jwt).not.toBe(second!.jwt);
  });

  it("does not follow a redirect: it comes back as the answer", async () => {
    const h = harness({upstream: [() => ({status: 302, headers: {location: "https://elsewhere.test/"}, body: ""})]});

    const response = await h.handle(refresh());

    expect(response.status).toBe(302);
    expect(h.upstreamRequests).toHaveLength(1);
  });
});

describe("key selection", () => {
  it("signs with the named key and reports it, even though a newer default exists", async () => {
    const h = harness({upstream: [() => json(200, {})]});

    const response = await h.handle(refresh({"nubecita-client-auth-kid": "test-1"}));

    expect(h.signedWith).toEqual(["test-1"]);
    expect(assertionOf(h.upstreamRequests[0]!).header["kid"]).toBe("test-1");
    expect(response.headers[KID_HEADER]).toBe("test-1");
  });

  it("refuses an unknown named key without forwarding or signing with another", async () => {
    const h = harness();

    const response = await h.handle(refresh({"nubecita-client-auth-kid": "test-0"}));

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({error: "mediator_unknown_key", forwarded: false});
    expect(h.signedWith).toHaveLength(0);
    expect(h.allRequests).toHaveLength(0);
  });

  it("refuses a client it holds no key for, without any outbound request", async () => {
    const h = harness();

    const response = await h.handle(post("/token", {grant_type: "refresh_token", client_id: "https://evil.example/c.json"}));

    expect(JSON.parse(response.body)).toEqual({error: "mediator_unknown_client", forwarded: false});
    expect(h.allRequests).toHaveLength(0);
  });
});

describe("the issuer", () => {
  it.each([
    ["an http issuer", "http://auth.test"],
    ["an IP literal", "https://169.254.169.254"],
    ["a path", "https://auth.test/oauth/token"],
    ["an internal name", "https://metadata.google.internal"],
  ])("refuses %s before any request is made", async (_label, issuer) => {
    const h = harness();

    const response = await h.handle(refresh({"nubecita-issuer": issuer}));

    expect(JSON.parse(response.body)).toEqual({error: "mediator_issuer_rejected", forwarded: false});
    expect(h.allRequests).toHaveLength(0);
  });

  it("refuses metadata that names a different issuer", async () => {
    const h = harness({metadata: json(200, {...JSON.parse(METADATA.body), issuer: "https://other.test"})});

    const response = await h.handle(refresh());

    expect(JSON.parse(response.body)).toEqual({error: "mediator_issuer_rejected", forwarded: false});
    expect(h.upstreamRequests).toHaveLength(0);
  });

  it("refuses metadata whose endpoint is on another origin", async () => {
    const h = harness({
      metadata: json(200, {...JSON.parse(METADATA.body), token_endpoint: "https://internal.example/oauth/token"}),
    });

    const response = await h.handle(refresh());

    expect(JSON.parse(response.body)).toEqual({error: "mediator_issuer_rejected", forwarded: false});
    expect(h.upstreamRequests).toHaveLength(0);
  });

  it("refuses when the address guard rejects the issuer's host", async () => {
    const h = harness({
      metadata: () => {
        throw new GuardError("host resolves to a non-public address");
      },
    });

    const response = await h.handle(refresh());

    expect(JSON.parse(response.body)).toEqual({error: "mediator_issuer_rejected", forwarded: false});
  });

  it("refuses a revocation when the issuer publishes no revocation endpoint", async () => {
    const withoutRevoke = JSON.parse(METADATA.body) as Record<string, unknown>;
    delete withoutRevoke["revocation_endpoint"];
    const h = harness({metadata: json(200, withoutRevoke)});

    const response = await h.handle(post("/revoke", {token: REFRESH_TOKEN}));

    expect(JSON.parse(response.body)).toEqual({error: "mediator_issuer_rejected", forwarded: false});
  });

  it("reads an issuer's metadata once and reuses it for ten minutes", async () => {
    const ok: Upstream = () => json(200, {});
    const h = harness({upstream: [ok, ok, ok]});
    const metadataFetches = () =>
      h.allRequests.filter((request) => request.url.pathname === "/.well-known/oauth-authorization-server").length;

    await h.handle(refresh({}, "ref-first"));
    await h.handle(refresh({}, "ref-second"));
    expect(metadataFetches()).toBe(1);

    h.advance(10 * 60_000 + 1);
    await h.handle(refresh({}, "ref-third"));
    expect(metadataFetches()).toBe(2);
  });
});

describe("failures", () => {
  it("says the outcome is unknown when the authorization server does not answer in time", async () => {
    const h = harness({
      upstream: [
        () => {
          throw new OutcomeUnknownError("timed out");
        },
      ],
    });

    const response = await h.handle(refresh());

    expect(response.status).toBe(504);
    expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
    expect(JSON.parse(response.body)).toEqual({error: "mediator_upstream_timeout", forwarded: "unknown"});
  });

  it("says nothing was forwarded when the authorization server could not be reached", async () => {
    const h = harness({
      upstream: [
        () => {
          throw new NotSentError("connection refused");
        },
      ],
    });

    const response = await h.handle(refresh());

    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({error: "mediator_upstream_unreachable", forwarded: false});
  });

  it("says nothing was forwarded when the issuer's metadata could not be fetched", async () => {
    const h = harness({
      metadata: () => {
        throw new NotSentError("dns");
      },
    });

    const response = await h.handle(refresh());

    expect(JSON.parse(response.body)).toEqual({error: "mediator_upstream_unreachable", forwarded: false});
  });

  it("turns an unexpected error after forwarding into 'unknown', never into silence", async () => {
    const h = harness({
      upstream: [
        () => {
          throw new Error("something unforeseen");
        },
      ],
    });

    const response = await h.handle(refresh());

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({error: "mediator_internal", forwarded: "unknown"});
  });

  it("never produces invalid_grant itself", async () => {
    const cases: Array<[ReturnType<typeof harness>, MediatorRequest]> = [
      [harness(), {...refresh(), path: "/nope"}],
      [harness({settings: {bypass: true}}), refresh()],
      [harness(), refresh({"nubecita-client-auth-kid": "missing"})],
      [harness(), refresh({"nubecita-issuer": "http://x"})],
      [harness({attestation: "invalid", settings: {enforceSignInAttestation: true}}), par()],
      [harness({upstream: [() => Promise.reject(new OutcomeUnknownError("t"))]}), refresh()],
      [harness({upstream: [() => Promise.reject(new NotSentError("t"))]}), refresh()],
      [harness({upstream: [() => Promise.reject(new Error("t"))]}), refresh()],
    ];
    for (const [h, request] of cases) {
      const response = await h.handle(request);
      expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
      expect(response.body).not.toContain("invalid_grant");
      expect(JSON.parse(response.body).error).toMatch(/^mediator_/);
    }
  });
});

describe("bypass mode", () => {
  it("answers 'not forwarded, go direct' and makes no outbound request at all", async () => {
    const h = harness({settings: {bypass: true}});

    for (const request of [par(), refresh(), post("/revoke", {token: REFRESH_TOKEN})]) {
      const response = await h.handle(request);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual({error: "mediator_bypass", forwarded: false});
    }
    expect(h.allRequests).toHaveLength(0);
    expect(h.signedWith).toHaveLength(0);
  });
});

describe("attestation", () => {
  const codeExchange = (): MediatorRequest => post("/token", {grant_type: "authorization_code", code: "cod-1"});
  const revoke = (): MediatorRequest => post("/revoke", {token: REFRESH_TOKEN});
  const kinds: Array<[string, () => MediatorRequest, boolean]> = [
    ["par", par, true],
    ["code exchange", codeExchange, true],
    ["refresh", refresh, false],
    ["revoke", revoke, false],
  ];

  for (const [name, request, isSignIn] of kinds) {
    for (const verdict of ["valid", "missing", "invalid"] as const) {
      for (const enforceSignIn of [false, true]) {
        for (const strictRefresh of [false, true]) {
          const blocked = verdict !== "valid" && (isSignIn ? enforceSignIn : strictRefresh);
          it(`${name} with a ${verdict} token, enforce=${enforceSignIn}, strict=${strictRefresh}: ${
            blocked ? "refused" : "forwarded"
          }`, async () => {
            const h = harness({
              upstream: [() => json(200, {})],
              attestation: verdict,
              settings: {enforceSignInAttestation: enforceSignIn, strictRefreshAttestation: strictRefresh},
            });

            const response = await h.handle(request());

            if (blocked) {
              expect(response.status).toBe(403);
              expect(JSON.parse(response.body)).toEqual({error: "mediator_attestation_required", forwarded: false});
              expect(h.upstreamRequests).toHaveLength(0);
            } else {
              expect(response.headers[ORIGIN_HEADER]).toBe("upstream");
              expect(h.upstreamRequests).toHaveLength(1);
            }
            expect(h.logs[0]!.attestation).toBe(verdict);
          });
        }
      }
    }
  }

  it("treats no token as missing and a failing verification as invalid, without throwing", async () => {
    const verify = attestationVerifier(async (token) => {
      if (token !== "good") throw new Error("bad token");
    });

    expect(await verify(undefined)).toBe("missing");
    expect(await verify("  ")).toBe("missing");
    expect(await verify("forged")).toBe("invalid");
    expect(await verify("good")).toBe("valid");
  });
});

describe("rate limiting", () => {
  it("refuses sign-in starts beyond the limit for one address, and only those", async () => {
    const ok: Upstream = () => json(201, {request_uri: "urn:x"});
    const h = harness({upstream: [ok, ok, ok], signInLimit: 2});

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await h.handle(par())).status);
    const other = await h.handle({...par(), callerAddress: "198.51.100.9"});

    expect(statuses).toEqual([201, 201, 429]);
    expect(other.status).toBe(201);
    expect(h.upstreamRequests).toHaveLength(3);
  });

  it("cannot be escaped by claiming a new address each time: the connecting address has its own ceiling", async () => {
    const ok: Upstream = () => json(201, {request_uri: "urn:x"});
    const h = harness({upstream: [ok, ok, ok], signInLimit: 1, connectionLimit: 3});

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      // A direct caller forges the first X-Forwarded-For entry; the last one is
      // appended by the platform and is the same for all five.
      statuses.push((await h.handle({...par(), callerAddress: `203.0.113.${i}`, connectingAddress: "198.51.100.1"})).status);
    }

    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    expect(h.upstreamRequests).toHaveLength(3);
  });

  it("does not let one caller's burst count against others behind the same connecting address", async () => {
    const ok: Upstream = () => json(201, {request_uri: "urn:x"});
    const h = harness({upstream: [ok, ok], signInLimit: 1, connectionLimit: 100});
    const edge = "198.51.100.1";

    const first = await h.handle({...par(), callerAddress: "203.0.113.1", connectingAddress: edge});
    const again = await h.handle({...par(), callerAddress: "203.0.113.1", connectingAddress: edge});
    const someoneElse = await h.handle({...par(), callerAddress: "203.0.113.2", connectingAddress: edge});

    expect([first.status, again.status, someoneElse.status]).toEqual([201, 429, 201]);
  });

  it("does not let one caller hammering past its own limit use up the connecting address's ceiling", async () => {
    const ok: Upstream = () => json(201, {request_uri: "urn:x"});
    const h = harness({upstream: [ok, ok, ok], signInLimit: 1, connectionLimit: 3});
    // Through Hosting the connecting address is an edge shared by many users.
    const edge = "198.51.100.1";

    const hammering = [];
    for (let i = 0; i < 10; i++) {
      hammering.push((await h.handle({...par(), callerAddress: "203.0.113.1", connectingAddress: edge})).status);
    }
    const others = [
      (await h.handle({...par(), callerAddress: "203.0.113.2", connectingAddress: edge})).status,
      (await h.handle({...par(), callerAddress: "203.0.113.3", connectingAddress: edge})).status,
    ];

    expect(hammering).toEqual([201, ...Array<number>(9).fill(429)]);
    expect(others).toEqual([201, 201]);
  });

  it("does not limit refreshes", async () => {
    const ok: Upstream = () => json(200, {});
    const h = harness({upstream: [ok, ok, ok], signInLimit: 1});

    for (let i = 0; i < 3; i++) expect((await h.handle(refresh({}, `ref-${i}`))).status).toBe(200);
    expect(h.upstreamRequests).toHaveLength(3);
  });
});

describe("the reported auth method", () => {
  it("reports a public client as none", async () => {
    const h = harness({upstream: [() => json(200, {})], clientMetadata: json(200, {token_endpoint_auth_method: "none"})});

    expect((await h.handle(refresh())).headers[AUTH_METHOD_HEADER]).toBe("none");
  });

  it("omits the header, and still relays, when the client's metadata cannot be read", async () => {
    const h = harness({
      upstream: [() => json(200, {ok: true})],
      clientMetadata: () => {
        throw new NotSentError("pages is down");
      },
    });

    const response = await h.handle(refresh());

    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty(AUTH_METHOD_HEADER);
  });
});

describe("logging", () => {
  it("records what happened and nothing that could identify or impersonate anyone", async () => {
    const did = "did:plc:alice1234567890";
    const code = "cod-0123456789abcdef";
    const tokens = {access_token: "at_secret_value", refresh_token: "ref-brand-new-secret", sub: did};
    const h = harness({
      upstream: [
        () => json(201, {request_uri: "urn:ietf:params:oauth:request_uri:req-secret"}),
        () => json(200, tokens),
        () => json(200, tokens),
        () => json(400, {error: "invalid_grant", error_description: `no session for ${did}`}),
        () => json(200, {}),
      ],
      attestation: "valid",
    });
    const appCheck = {"x-firebase-appcheck": "appcheck-token-secret"};

    await h.handle(par(appCheck));
    await h.handle(post("/token", {grant_type: "authorization_code", code, code_verifier: "verifier-secret"}, appCheck));
    await h.handle(refresh(appCheck));
    await h.handle(refresh(appCheck, tokens.refresh_token));
    await h.handle(post("/revoke", {token: REFRESH_TOKEN}, appCheck));

    expect(h.logs.map((entry) => entry.kind)).toEqual(["par", "code_exchange", "refresh", "refresh", "revoke"]);
    expect(h.logs[2]).toEqual({
      kind: "refresh",
      issuerHost: "auth.test",
      status: 200,
      origin: "upstream",
      forwarded: true,
      latencyMs: 0,
      kid: "test-2",
      attestation: "valid",
      replayed: false,
    });
    expect(h.logs[3]!.upstreamError).toBe("invalid_grant");

    const written = JSON.stringify(h.logs);
    const assertions = h.upstreamRequests.map((request) => assertionOf(request).jwt);
    for (const secret of [
      REFRESH_TOKEN,
      "at_secret_value",
      "ref-brand-new-secret",
      code,
      "verifier-secret",
      "req-secret",
      DPOP,
      did,
      "alice",
      "appcheck-token-secret",
      "203.0.113.7",
      CLIENT_ID,
      ...assertions,
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  it("logs a refusal with its reason", async () => {
    const h = harness({settings: {bypass: true}});

    await h.handle(refresh());

    expect(h.logs[0]).toMatchObject({kind: "refresh", origin: "mediator", reason: "bypass", forwarded: false, status: 503});
  });

  it("drops an upstream error value that does not look like an OAuth error code", async () => {
    const h = harness({upstream: [() => json(400, {error: "did:plc:alice said no"})]});

    await h.handle(refresh());

    expect(h.logs[0]).not.toHaveProperty("upstreamError");
  });
});

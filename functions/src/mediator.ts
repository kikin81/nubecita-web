import {type Signer, mintClientAssertion} from "./assertion";
import {type RequestKind, type VerifyAttestation, type AttestationVerdict, mayProceed} from "./attestation";
import type {ReadClientAuthMethod} from "./clientMetadata";
import {type ClientConfig, selectKey} from "./clients";
import {isProofFor, proofKeyThumbprint} from "./dpop";
import {GuardError} from "./guard";
import type {AuthorizationServer, ResolveIssuer} from "./issuer";
import {type LogSink, type RequestLog, oauthErrorCode} from "./log";
import {type Send, NotSentError, OutcomeUnknownError} from "./outbound";
import type {RateLimit} from "./rateLimit";
import {entryId, issuedMark, issuedRefreshToken, open, seal} from "./replayCrypto";
import type {ReplayStore, StoredResponse} from "./replayStore";
import {type Forwarded, type MediatorReason, type MediatorResponse, mediatorError, relayed, replayed} from "./responses";
import type {ReadSettings} from "./settings";

/** The parts of an incoming HTTP request the backend looks at. */
export interface MediatorRequest {
  method: string;
  /** Path as received, without the query string. */
  path: string;
  /** Header names lower-cased. */
  headers: Record<string, string | undefined>;
  /** Raw `application/x-www-form-urlencoded` body. */
  body: string;
  /**
   * The address the caller claims to come from: the first forwarded hop. A
   * caller reaching the service directly can set this to anything. For rate
   * limiting only; never logged.
   */
  callerAddress?: string;
  /**
   * The address that actually connected to the platform: the last forwarded
   * hop, which the platform appends and a caller cannot forge. Shared by many
   * users when it is a proxy in front of the service. For rate limiting only;
   * never logged.
   */
  connectingAddress?: string;
}

export interface MediatorDeps {
  clients: readonly ClientConfig[];
  signer: Signer;
  send: Send;
  resolveIssuer: ResolveIssuer;
  readClientAuthMethod: ReadClientAuthMethod;
  verifyAttestation: VerifyAttestation;
  /** Per claimed caller address: the tight, per-user limit. */
  allowSignInStart: RateLimit;
  /** Per connecting address: a looser ceiling that forging the claimed address cannot escape. */
  allowSignInStartFromConnection: RateLimit;
  settings: ReadSettings;
  /** Remembers refreshes: one forward at a time per refresh token, and lost answers given again. */
  replayStore: ReplayStore;
  /** Longest wait for one replay-store operation, in milliseconds. Only tests set it. */
  storeTimeoutMs?: number;
  log: LogSink;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** A value that never repeats, for the assertion's `jti`. */
  newId: () => string;
}

/** How long to wait for an authorization server before telling the app the outcome is unknown. */
export const UPSTREAM_TIMEOUT_MS = 25_000;
const UPSTREAM_MAX_BYTES = 256 * 1024;

/**
 * The replay store is given this long before a refresh is forwarded (room for
 * a cold connection), and less once the authorization server has answered:
 * by then the device is waiting for tokens that exist nowhere else, and the
 * function's own time limit is close.
 */
const STORE_TIMEOUT_MS = 4_000;
const STORE_RECORD_TIMEOUT_MS = 2_500;
/**
 * A refresh that has been answered waits no longer than this to learn the
 * client's registered auth method. The lookup started with the forward and
 * has normally finished long before.
 */
const AUTH_METHOD_GRACE_MS = 1_000;

const STATUS: Record<MediatorReason, number> = {
  not_found: 404,
  bad_request: 400,
  bypass: 503,
  attestation_required: 403,
  unknown_client: 400,
  unknown_key: 409,
  issuer_rejected: 400,
  rate_limited: 429,
  upstream_timeout: 504,
  upstream_unreachable: 502,
  in_progress: 409,
  internal: 500,
};

export type HandleRequest = (request: MediatorRequest) => Promise<MediatorResponse>;

export function createMediator(deps: MediatorDeps): HandleRequest {
  return async (request) => {
    const started = deps.now();
    const entry: RequestLog = {
      kind: "unrouted",
      status: 0,
      origin: "mediator",
      forwarded: false,
      latencyMs: 0,
      attestation: "not_checked",
      replayed: false,
    };
    const refuse = (reason: MediatorReason, forwarded: Forwarded = false): MediatorResponse => {
      entry.origin = "mediator";
      entry.reason = reason;
      entry.forwarded = forwarded;
      return mediatorError(STATUS[reason], reason, forwarded);
    };

    let response: MediatorResponse;
    try {
      response = await mediate(deps, request, entry, refuse);
    } catch {
      // Whatever went wrong, the app must be told truthfully whether the
      // request may have reached the authorization server.
      response = refuse("internal", entry.forwarded === false ? false : "unknown");
    }
    entry.status = response.status;
    entry.latencyMs = deps.now() - started;
    deps.log(entry);
    return response;
  };
}

async function mediate(
  deps: MediatorDeps,
  request: MediatorRequest,
  entry: RequestLog,
  refuse: (reason: MediatorReason, forwarded?: Forwarded) => MediatorResponse,
): Promise<MediatorResponse> {
  if (request.method !== "POST") return refuse("not_found");
  const form = new URLSearchParams(request.body);
  const kind = kindOf(request.path, form);
  if (kind === "unknown_path") return refuse("not_found");
  if (kind === "unknown_grant") return refuse("bad_request");
  entry.kind = kind;

  const settings = deps.settings();
  const dpopProof = request.headers["dpop"];
  const store = deps.replayStore;
  const refreshToken = kind === "refresh" ? form.get("refresh_token") || undefined : undefined;
  // Only a refresh goes through the replay store. Nothing else it could hold
  // would be safe to give out twice.
  const refresh = refreshToken === undefined ? undefined : {token: refreshToken, id: entryId(refreshToken)};

  if (settings.bypass) {
    // "Use the direct path" is the wrong answer to a refresh that already
    // succeeded: its refresh token is spent, and presenting it again deletes
    // the session. The stored answer is given instead.
    if (refresh !== undefined) {
      const stored = await within(store.read(refresh.id, deps.now()), deps.storeTimeoutMs ?? STORE_TIMEOUT_MS).catch(() => {
        entry.replayStore = "unavailable";
        return undefined;
      });
      const answer = stored === undefined ? undefined : serveStored(deps, entry, refresh, stored, dpopProof);
      if (answer !== undefined) return answer;
    }
    return refuse("bypass");
  }

  const issuerInput = request.headers["nubecita-issuer"];
  if (dpopProof === undefined || issuerInput === undefined) return refuse("bad_request");

  const key = selectKey(deps.clients, form.get("client_id") ?? undefined, request.headers["nubecita-client-auth-kid"]);
  if (!key.ok) return refuse(key.reason);
  entry.kid = key.kid;

  if (kind === "par") {
    // The caller's own limit first, and a request it refuses is not counted
    // against the connecting address. Through Hosting that address is an edge
    // shared by many users, so one client hammering away past its own limit
    // must not use up everyone's ceiling. A caller that forges a new address
    // each time passes the first check and is counted by the second.
    if (!deps.allowSignInStart(request.callerAddress ?? "unknown")) return refuse("rate_limited");
    if (!deps.allowSignInStartFromConnection(request.connectingAddress ?? "unknown")) return refuse("rate_limited");
  }

  const verdict: AttestationVerdict = await deps.verifyAttestation(request.headers["x-firebase-appcheck"]);
  entry.attestation = verdict;
  if (!mayProceed(kind, verdict, settings)) return refuse("attestation_required");

  // Settles before the forward. Never rejects.
  let superseded: Promise<void> = Promise.resolve();
  if (refresh !== undefined) {
    const now = deps.now();
    let stored: StoredResponse | undefined;
    let handedOutBy: {id: string; storedAt: number} | undefined;
    try {
      [stored, handedOutBy] = await within(
        Promise.all([store.read(refresh.id, now), store.issuedBy(issuedMark(refresh.token), now)]),
        deps.storeTimeoutMs ?? STORE_TIMEOUT_MS,
      );
    } catch {
      // Without the store there is no telling whether this refresh token is
      // already spent or being forwarded right now, and forwarding it in
      // either case can delete the session. Refusing costs a retry.
      entry.replayStore = "unavailable";
      return refuse("internal");
    }

    if (stored !== undefined) {
      // This refresh already succeeded, so its token is spent. The caller gets
      // the answer if it proves it holds the key the refresh was made with,
      // and is otherwise refused: forwarding a spent token would only delete
      // the session.
      return serveStored(deps, entry, refresh, stored, dpopProof) ?? refuse("bad_request");
    }

    if (handedOutBy !== undefined) {
      // The entry whose answer handed this refresh token out says when that
      // was. While the operator's minimum interval has not passed, the token
      // is not forwarded and that entry stays, to keep saying so.
      if (settings.minRefreshIntervalMs > 0 && now - handedOutBy.storedAt < settings.minRefreshIntervalMs) {
        return refuse("rate_limited");
      }
      // The device is using the token from that answer, so it received it,
      // and the answer need not be kept.
      superseded = within(store.remove(handedOutBy.id), deps.storeTimeoutMs ?? STORE_TIMEOUT_MS).catch(() => {
        entry.replayStore = "write_failed";
      });
    }
  }

  let server: AuthorizationServer;
  try {
    server = await deps.resolveIssuer(issuerInput);
  } catch (error) {
    if (error instanceof GuardError) return refuse("issuer_rejected");
    // The metadata lookup failed; the request itself was never sent.
    return refuse("upstream_unreachable");
  }
  entry.issuerHost = new URL(server.issuer).hostname;

  const endpoint =
    kind === "par" ? server.parEndpoint : kind === "revoke" ? server.revocationEndpoint : server.tokenEndpoint;
  if (endpoint === undefined) return refuse("issuer_rejected");

  const clientId = form.get("client_id") ?? "";
  const assertion = await mintClientAssertion(
    {clientId, issuer: server.issuer, kid: key.kid, nowSeconds: Math.floor(deps.now() / 1000), jti: deps.newId()},
    deps.signer,
  );
  // The caller's form goes on unchanged, except that client authentication is
  // ours to add: anything the caller put in those two fields is dropped.
  form.delete("client_assertion");
  form.delete("client_assertion_type");
  form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  form.set("client_assertion", assertion);

  // Single flight: the claim is taken last, when nothing but the forward
  // itself is left to go wrong, so a refusal above never leaves one behind.
  let lease: string | undefined;
  if (refresh !== undefined) {
    await superseded;
    let claim;
    try {
      claim = await within(store.claim(refresh.id, deps.now()), deps.storeTimeoutMs ?? STORE_TIMEOUT_MS);
    } catch {
      entry.replayStore = "unavailable";
      return refuse("internal");
    }
    // Another attempt with this refresh token may have reached the
    // authorization server, so the app must not treat the token as unspent.
    if (claim.outcome === "in_progress") return refuse("in_progress", "unknown");
    // It finished between the look above and the claim.
    if (claim.outcome === "stored") return serveStored(deps, entry, refresh, claim.response, dpopProof) ?? refuse("bad_request");
    lease = claim.lease;
  }

  // Starts in parallel with the forward; it is only for the response header.
  const authMethod = deps.readClientAuthMethod(clientId).catch(() => undefined);

  entry.forwarded = "unknown";
  let upstream;
  try {
    upstream = await deps.send({
      url: endpoint,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        // Made by the device for this endpoint; passed on byte for byte.
        dpop: dpopProof,
      },
      body: form.toString(),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxResponseBytes: UPSTREAM_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof NotSentError || error instanceof GuardError) {
      // Nothing left the backend, so the refresh token is unspent and the next attempt may go ahead.
      if (refresh !== undefined && lease !== undefined) await letGo(deps, entry, refresh.id, lease);
      return refuse("upstream_unreachable", false);
    }
    // From here the outcome is unknown, and the claim is left in place: for
    // the next minute a retry is held back instead of being forwarded again.
    if (error instanceof OutcomeUnknownError) return refuse("upstream_timeout", "unknown");
    throw error;
  }

  entry.forwarded = true;
  entry.origin = "upstream";
  const upstreamError = upstream.status >= 400 ? oauthErrorCode(upstream.body) : undefined;
  if (upstreamError !== undefined) entry.upstreamError = upstreamError;

  if (refresh === undefined || lease === undefined) return relayed(upstream, key.kid, await authMethod);

  const method = await within(authMethod, AUTH_METHOD_GRACE_MS).catch(() => undefined);
  if (upstream.status >= 200 && upstream.status < 300) {
    // The refresh token is now spent, and the tokens that replace it exist
    // only in this response. It is recorded before it is sent, so that if it
    // is lost on the way the device can ask again. Failing to record it must
    // not cost the device the response it is waiting for.
    try {
      const jkt = proofKeyThumbprint(dpopProof);
      if (jkt === undefined) throw new Error("the accepted proof could not be read");
      const sealed = seal(refresh.token, refresh.id, {
        status: upstream.status,
        body: upstream.body,
        contentType: upstream.headers["content-type"],
        dpopNonce: upstream.headers["dpop-nonce"],
        kid: key.kid,
        authMethod: method,
        jkt,
        htu: endpoint.href,
      });
      const issued = issuedRefreshToken(upstream.body);
      await within(
        store.complete(refresh.id, sealed, issued === undefined ? undefined : issuedMark(issued), deps.now()),
        deps.storeTimeoutMs ?? STORE_RECORD_TIMEOUT_MS,
      );
    } catch {
      entry.replayStore = "write_failed";
    }
  } else {
    // Any other answer (a nonce challenge above all) means the refresh token
    // was not consumed, and the retry that follows must not be held back.
    await letGo(deps, entry, refresh.id, lease);
  }
  return relayed(upstream, key.kid, method);
}

/**
 * Answers a refresh from the replay store. Only for a caller that presents a
 * genuine, recent DPoP proof made with the same key as the refresh the answer
 * belongs to; anyone else gets nothing.
 */
function serveStored(
  deps: MediatorDeps,
  entry: RequestLog,
  refresh: {token: string; id: string},
  stored: StoredResponse,
  dpopProof: string | undefined,
): MediatorResponse | undefined {
  if (dpopProof === undefined) return undefined;
  const payload = open(refresh.token, refresh.id, stored.sealed);
  if (payload === undefined) return undefined;
  if (!isProofFor(dpopProof, {jkt: payload.jkt, htu: payload.htu, nowMs: deps.now()})) return undefined;

  entry.origin = "upstream";
  entry.forwarded = false;
  entry.replayed = true;
  entry.kid = payload.kid;
  entry.issuerHost = new URL(payload.htu).hostname;
  return replayed(payload);
}

/** Gives a claim back. If that fails the claim simply lapses after a minute. */
async function letGo(deps: MediatorDeps, entry: RequestLog, id: string, lease: string): Promise<void> {
  try {
    await within(deps.replayStore.release(id, lease), deps.storeTimeoutMs ?? STORE_RECORD_TIMEOUT_MS);
  } catch {
    entry.replayStore = "write_failed";
  }
}

/** Settles as `work` does, or rejects once `ms` have passed. The work itself is not stopped. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function kindOf(path: string, form: URLSearchParams): RequestKind | "unknown_path" | "unknown_grant" {
  switch (path) {
    case "/par":
      return "par";
    case "/revoke":
      return "revoke";
    case "/token":
      switch (form.get("grant_type")) {
        case "authorization_code":
          return "code_exchange";
        case "refresh_token":
          return "refresh";
        default:
          return "unknown_grant";
      }
    default:
      return "unknown_path";
  }
}

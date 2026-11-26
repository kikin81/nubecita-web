import {type Signer, mintClientAssertion} from "./assertion";
import {type RequestKind, type VerifyAttestation, type AttestationVerdict, mayProceed} from "./attestation";
import type {ReadClientAuthMethod} from "./clientMetadata";
import {type ClientConfig, selectKey} from "./clients";
import {GuardError} from "./guard";
import type {AuthorizationServer, ResolveIssuer} from "./issuer";
import {type LogSink, type RequestLog, oauthErrorCode} from "./log";
import {type Send, NotSentError, OutcomeUnknownError} from "./outbound";
import type {RateLimit} from "./rateLimit";
import {type Forwarded, type MediatorReason, type MediatorResponse, mediatorError, relayed} from "./responses";
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
  log: LogSink;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** A value that never repeats, for the assertion's `jti`. */
  newId: () => string;
}

/** How long to wait for an authorization server before telling the app the outcome is unknown. */
export const UPSTREAM_TIMEOUT_MS = 25_000;
const UPSTREAM_MAX_BYTES = 256 * 1024;

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
  if (settings.bypass) return refuse("bypass");

  const dpopProof = request.headers["dpop"];
  const issuerInput = request.headers["nubecita-issuer"];
  if (dpopProof === undefined || issuerInput === undefined) return refuse("bad_request");

  const key = selectKey(deps.clients, form.get("client_id") ?? undefined, request.headers["nubecita-client-auth-kid"]);
  if (!key.ok) return refuse(key.reason);
  entry.kid = key.kid;

  if (kind === "par") {
    // Both are counted on every sign-in start, so neither can be starved by
    // tripping the other first.
    const withinConnectionCeiling = deps.allowSignInStartFromConnection(request.connectingAddress ?? "unknown");
    const withinCallerLimit = deps.allowSignInStart(request.callerAddress ?? "unknown");
    if (!withinConnectionCeiling || !withinCallerLimit) return refuse("rate_limited");
  }

  const verdict: AttestationVerdict = await deps.verifyAttestation(request.headers["x-firebase-appcheck"]);
  entry.attestation = verdict;
  if (!mayProceed(kind, verdict, settings)) return refuse("attestation_required");

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
    if (error instanceof NotSentError || error instanceof GuardError) return refuse("upstream_unreachable", false);
    if (error instanceof OutcomeUnknownError) return refuse("upstream_timeout", "unknown");
    throw error;
  }

  entry.forwarded = true;
  entry.origin = "upstream";
  const upstreamError = upstream.status >= 400 ? oauthErrorCode(upstream.body) : undefined;
  if (upstreamError !== undefined) entry.upstreamError = upstreamError;
  return relayed(upstream, key.kid, await authMethod);
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

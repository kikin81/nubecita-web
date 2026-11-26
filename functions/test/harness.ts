import {generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify} from "node:crypto";
import type {Signer} from "../src/assertion";
import type {AttestationVerdict} from "../src/attestation";
import {createClientAuthMethodReader} from "../src/clientMetadata";
import type {ClientConfig} from "../src/clients";
import {createIssuerResolver} from "../src/issuer";
import type {RequestLog} from "../src/log";
import {type MediatorRequest, createMediator} from "../src/mediator";
import type {OutboundRequest, OutboundResponse} from "../src/outbound";
import {createRateLimit} from "../src/rateLimit";
import type {ReplayStore} from "../src/replayStore";
import type {Settings} from "../src/settings";
import {memoryReplayStore} from "./memoryReplayStore";
import {ISSUER, START, TOKEN_ENDPOINT, dpopProof, newToken} from "./proofs";

export {DEVICE, ISSUER, START, TOKEN_ENDPOINT, deviceKey, dpopProof, tokenTraces} from "./proofs";

export const CLIENT_ID = "https://nubecita.app/oauth/client-metadata-test.json";
const {privateKey, publicKey} = generateKeyPairSync("ec", {namedCurve: "P-256"});

const clients: ClientConfig[] = [{clientId: CLIENT_ID, defaultKid: "test-2", keys: {"test-1": "kms/1", "test-2": "kms/2"}}];

export const METADATA: OutboundResponse = {
  status: 200,
  headers: {"content-type": "application/json"},
  body: JSON.stringify({
    issuer: ISSUER,
    pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
    token_endpoint: TOKEN_ENDPOINT,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
  }),
};

export type Upstream = (request: OutboundRequest) => OutboundResponse | Promise<OutboundResponse>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): OutboundResponse {
  return {
    status,
    headers: {"content-type": "application/json", date: "Wed, 25 Nov 2026 10:00:00 GMT", ...headers},
    body: JSON.stringify(body),
  };
}

export function harness(
  options: {
    upstream?: Upstream[];
    metadata?: OutboundResponse | (() => OutboundResponse);
    clientMetadata?: OutboundResponse | (() => OutboundResponse);
    settings?: Partial<Settings>;
    attestation?: AttestationVerdict;
    signInLimit?: number;
    connectionLimit?: number;
    replayStore?: ReplayStore;
    storeTimeoutMs?: number;
  } = {},
) {
  const upstreamRequests: OutboundRequest[] = [];
  const allRequests: OutboundRequest[] = [];
  const signedWith: string[] = [];
  const logs: RequestLog[] = [];
  const script = [...(options.upstream ?? [])];
  const settings: Settings = {
    bypass: false,
    enforceSignInAttestation: false,
    strictRefreshAttestation: false,
    minRefreshIntervalMs: 0,
    ...options.settings,
  };
  let time = START;
  let ids = 0;

  const send = async (request: OutboundRequest): Promise<OutboundResponse> => {
    allRequests.push(request);
    if (request.url.pathname === "/.well-known/oauth-authorization-server") {
      const metadata = options.metadata ?? METADATA;
      return typeof metadata === "function" ? metadata() : metadata;
    }
    if (request.url.href === CLIENT_ID) {
      const clientMetadata = options.clientMetadata ?? json(200, {token_endpoint_auth_method: "private_key_jwt"});
      return typeof clientMetadata === "function" ? clientMetadata() : clientMetadata;
    }
    upstreamRequests.push(request);
    const next = script.shift();
    if (next === undefined) throw new Error("unexpected upstream request");
    return next(request);
  };
  const signer: Signer = {
    async signDer(kid, signingInput) {
      signedWith.push(kid);
      return cryptoSign("sha256", signingInput, {key: privateKey, dsaEncoding: "der"});
    },
  };
  const now = (): number => time;
  const handle = createMediator({
    clients,
    signer,
    send,
    resolveIssuer: createIssuerResolver(send, now),
    readClientAuthMethod: createClientAuthMethodReader(send, now),
    verifyAttestation: async () => options.attestation ?? "valid",
    allowSignInStart: createRateLimit(options.signInLimit ?? 100, 60_000, now),
    allowSignInStartFromConnection: createRateLimit(options.connectionLimit ?? 1_000, 60_000, now),
    settings: () => settings,
    replayStore: options.replayStore ?? memoryReplayStore(),
    storeTimeoutMs: options.storeTimeoutMs,
    log: (entry) => logs.push({...entry}),
    now,
    newId: () => `jti-${++ids}`,
  });
  return {
    handle,
    upstreamRequests,
    allRequests,
    signedWith,
    logs,
    /** Switches can be flipped while the harness runs, as on the real service. */
    settings,
    now,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

export const DPOP = dpopProof();
export const REFRESH_TOKEN = newToken();

export function post(path: string, form: Record<string, string>, headers: Record<string, string | undefined> = {}): MediatorRequest {
  return {
    method: "POST",
    path,
    headers: {dpop: DPOP, "nubecita-issuer": ISSUER, ...headers},
    body: new URLSearchParams({client_id: CLIENT_ID, ...form}).toString(),
    callerAddress: "203.0.113.7",
  };
}
export const refresh = (headers: Record<string, string | undefined> = {}, token = REFRESH_TOKEN): MediatorRequest =>
  post("/token", {grant_type: "refresh_token", refresh_token: token}, headers);
export const par = (headers: Record<string, string | undefined> = {}): MediatorRequest =>
  post("/par", {response_type: "code", code_challenge: "abc", code_challenge_method: "S256", state: "s"}, headers);

export function assertionOf(request: OutboundRequest) {
  const form = new URLSearchParams(request.body);
  const jwt = form.get("client_assertion") ?? "";
  const [header, payload, signature] = jwt.split(".");
  return {
    form,
    jwt,
    header: JSON.parse(Buffer.from(header ?? "", "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<string, unknown>,
    verifies: cryptoVerify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      {key: publicKey, dsaEncoding: "ieee-p1363"},
      Buffer.from(signature ?? "", "base64url"),
    ),
  };
}

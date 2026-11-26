import {GuardError, parseIssuer} from "./guard";
import type {Send} from "./outbound";

/** The endpoints of an authorization server, as it publishes them itself. */
export interface AuthorizationServer {
  issuer: string;
  parEndpoint: URL;
  tokenEndpoint: URL;
  revocationEndpoint: URL | undefined;
}

export type ResolveIssuer = (issuer: string) => Promise<AuthorizationServer>;

const METADATA_TIMEOUT_MS = 10_000;
const METADATA_MAX_BYTES = 64 * 1024;

/**
 * Turns an issuer named by a device into endpoints, by reading the issuer's
 * own metadata. The device never supplies an endpoint URL: it can only choose
 * which authorization server's published endpoints are used.
 *
 * @throws GuardError when the issuer or its metadata is not acceptable.
 */
export function createIssuerResolver(send: Send, now: () => number, ttlMs = 10 * 60_000, maxEntries = 500): ResolveIssuer {
  const cache = new Map<string, {server: AuthorizationServer; expires: number}>();

  return async (issuerInput) => {
    const origin = parseIssuer(issuerInput).origin;
    const cached = cache.get(origin);
    if (cached !== undefined && cached.expires > now()) return cached.server;

    const response = await send({
      url: new URL("/.well-known/oauth-authorization-server", origin),
      method: "GET",
      headers: {accept: "application/json"},
      timeoutMs: METADATA_TIMEOUT_MS,
      maxResponseBytes: METADATA_MAX_BYTES,
    });
    if (response.status !== 200) throw new GuardError("issuer metadata unavailable");

    let metadata: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(response.body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      metadata = parsed as Record<string, unknown>;
    } catch {
      throw new GuardError("issuer metadata is not JSON");
    }
    // A document served by one host that names another issuer is how a
    // request meant for one server would be signed for a different one.
    if (metadata["issuer"] !== origin) throw new GuardError("issuer metadata names a different issuer");

    const server: AuthorizationServer = {
      issuer: origin,
      parEndpoint: endpoint(metadata["pushed_authorization_request_endpoint"], origin, true),
      tokenEndpoint: endpoint(metadata["token_endpoint"], origin, true),
      revocationEndpoint: endpoint(metadata["revocation_endpoint"], origin, false),
    };

    if (cache.size >= maxEntries) cache.clear();
    cache.set(origin, {server, expires: now() + ttlMs});
    return server;
  };
}

function endpoint(value: unknown, origin: string, required: true): URL;
function endpoint(value: unknown, origin: string, required: false): URL | undefined;
function endpoint(value: unknown, origin: string, required: boolean): URL | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new GuardError("issuer metadata is missing an endpoint");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GuardError("issuer metadata has a malformed endpoint");
  }
  // AT Protocol authorization servers serve their endpoints from the issuer's
  // own origin. Holding them to that keeps a metadata document from pointing
  // the backend anywhere else.
  if (url.origin !== origin) throw new GuardError("issuer metadata points to another origin");
  return url;
}

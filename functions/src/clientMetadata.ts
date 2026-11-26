import type {Send} from "./outbound";

/** A client's registered `token_endpoint_auth_method`, as its published metadata states it. */
export type ClientAuthMethod = "none" | "private_key_jwt";

export type ReadClientAuthMethod = (clientId: string) => Promise<ClientAuthMethod | undefined>;

/**
 * Reads what a client's own published metadata registers, so responses can
 * tell the app which session lifetime applies. Best effort: a failure means
 * "unknown", never a failed request. The value can trail an authorization
 * server's cached copy by a few minutes around a metadata change.
 */
export function createClientAuthMethodReader(send: Send, now: () => number, ttlMs = 5 * 60_000): ReadClientAuthMethod {
  const cache = new Map<string, {method: ClientAuthMethod | undefined; expires: number}>();

  return async (clientId) => {
    const cached = cache.get(clientId);
    if (cached !== undefined && cached.expires > now()) return cached.method;

    let method: ClientAuthMethod | undefined;
    try {
      const response = await send({
        url: new URL(clientId),
        method: "GET",
        headers: {accept: "application/json"},
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
      });
      const value: unknown = response.status === 200 ? JSON.parse(response.body)?.token_endpoint_auth_method : undefined;
      if (value === "none" || value === "private_key_jwt") method = value;
    } catch {
      method = undefined;
    }
    // An unknown answer is retried sooner than a known one.
    cache.set(clientId, {method, expires: now() + (method === undefined ? 30_000 : ttlMs)});
    return method;
  };
}

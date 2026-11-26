/** An OAuth client this backend authenticates for, and the keys it may sign with. */
export interface ClientConfig {
  /** The client's `client_id`: the URL of its published metadata document. */
  clientId: string;
  /** Key used when a request names none: new sign-ins, and sessions not yet bound to a key. */
  defaultKid: string;
  /** Every key still held for this client, by key id, mapped to its key-service resource. */
  keys: Record<string, string>;
}

export type KeySelection =
  | {ok: true; kid: string; keyVersion: string}
  | {ok: false; reason: "unknown_client" | "unknown_key"};

/**
 * Picks the key to sign with. A named key is used exactly or not at all: the
 * authorization server deletes a session that is refreshed with a different
 * key from the one it is bound to, so substituting one would sign the user
 * out.
 */
export function selectKey(clients: readonly ClientConfig[], clientId: string | undefined, requestedKid: string | undefined): KeySelection {
  const client = clients.find((candidate) => candidate.clientId === clientId);
  if (client === undefined) return {ok: false, reason: "unknown_client"};
  const kid = requestedKid?.trim() ? requestedKid.trim() : client.defaultKid;
  if (!Object.hasOwn(client.keys, kid)) return {ok: false, reason: "unknown_key"};
  const keyVersion = client.keys[kid];
  if (keyVersion === undefined) return {ok: false, reason: "unknown_key"};
  return {ok: true, kid, keyVersion};
}

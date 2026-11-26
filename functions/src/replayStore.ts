/**
 * Where the backend remembers refreshes, so that a refresh token is forwarded
 * at most once at a time and a refresh whose answer was lost on the way to
 * the device can be answered again.
 *
 * AT Protocol refresh tokens are single-use, and an authorization server
 * deletes the whole session when a spent one is presented again. Without this
 * store, a response lost between the backend and the phone ends the session:
 * the phone can only retry with the token it still has.
 *
 * The store never sees a token. Entries are named by a hash of the refresh
 * token they answer, and hold a response already encrypted under a key that
 * only that token yields (see replayCrypto.ts).
 */

/**
 * How long a claim holds other attempts back. Twice the function's timeout:
 * a claim older than this belongs to an attempt that has certainly ended
 * without recording what happened.
 */
export const CLAIM_WINDOW_MS = 60_000;

/**
 * How long a stored response can be fetched. Long enough for a refresh that
 * died with the app's process to be retried when the app is next opened.
 */
export const ENTRY_LIFETIME_MS = 24 * 60 * 60_000;

/** An encrypted response. Unreadable without the refresh token it answers. */
export interface SealedResponse {
  salt: Uint8Array;
  iv: Uint8Array;
  /** Ciphertext followed by the authentication tag. */
  ciphertext: Uint8Array;
}

export interface StoredResponse {
  sealed: SealedResponse;
  /** Milliseconds since the epoch. */
  storedAt: number;
}

export type Claim =
  /** The caller may forward. `lease` names this attempt when it lets go. */
  | {outcome: "claimed"; lease: string}
  /** Another attempt with this refresh token started less than a minute ago. */
  | {outcome: "in_progress"}
  /** The refresh already succeeded. */
  | {outcome: "stored"; response: StoredResponse};

export interface ReplayStore {
  /** The stored response for a refresh token, unless there is none or it has expired. */
  read(id: string, now: number): Promise<StoredResponse | undefined>;

  /**
   * Atomically takes the right to forward a refresh token. Of any number of
   * simultaneous callers, exactly one is told "claimed".
   */
  claim(id: string, now: number): Promise<Claim>;

  /**
   * Records the authorization server's answer. `issued` marks the refresh
   * token that answer handed out, so the entry can be found when that token
   * is used in turn.
   */
  complete(id: string, sealed: SealedResponse, issued: string | undefined, now: number): Promise<void>;

  /**
   * Gives a claim back because the refresh token was not consumed. Does
   * nothing if the entry is no longer this attempt's claim.
   */
  release(id: string, lease: string): Promise<void>;

  /** The entry whose stored response handed out the refresh token marked `issued`. */
  issuedBy(issued: string, now: number): Promise<{id: string; storedAt: number} | undefined>;

  remove(id: string): Promise<void>;
}

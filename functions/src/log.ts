import type {AttestationVerdict, RequestKind} from "./attestation";
import type {Forwarded, MediatorReason} from "./responses";

/**
 * Everything the backend ever logs about a request. There is deliberately no
 * free-form field: a body, token, code, DPoP proof, client assertion, DID or
 * handle has nowhere to go.
 */
export interface RequestLog {
  kind: RequestKind | "unrouted";
  /** Hostname only, never a full URL. */
  issuerHost?: string;
  status: number;
  origin: "upstream" | "mediator";
  /** Why the backend answered itself. Absent on a relayed response. */
  reason?: MediatorReason;
  forwarded: Forwarded;
  /** The OAuth `error` code the authorization server returned, if any. */
  upstreamError?: string;
  /**
   * Why the authorization server refused, sorted into a fixed list from its
   * `error_description`. The description itself is never logged.
   */
  upstreamErrorDetail?: UpstreamErrorDetail;
  latencyMs: number;
  kid?: string;
  attestation: AttestationVerdict | "not_checked";
  /** True when the answer came from the replay store instead of the authorization server. */
  replayed: boolean;
  /**
   * Set only when the replay store let a refresh down: `unavailable` when it
   * could not be consulted, so the refresh was not forwarded, and
   * `write_failed` when the refresh went ahead but its outcome could not be
   * recorded.
   */
  replayStore?: "unavailable" | "write_failed";
}

/**
 * The refusals worth telling apart. Two error codes each cover opposite
 * cases: `invalid_grant` is a session that reached its lifetime or a refresh
 * token already spent, and `invalid_dpop_proof` is a proof the server could
 * not verify or one it had already seen. The last means the request reached
 * the server twice, and the first copy may have spent the refresh token.
 */
export type UpstreamErrorDetail =
  | "refresh_token_replayed"
  | "session_expired"
  | "refresh_token_expired"
  | "dpop_proof_replayed"
  | "dpop_proof_unverified"
  | "dpop_proof_other"
  | "dpop_key_binding"
  | "other"
  | "none";

export type LogSink = (entry: RequestLog) => void;

/** One JSON line per request, in the shape Cloud Logging parses. */
export const stdoutSink: LogSink = (entry) => {
  const severity = entry.origin === "mediator" && entry.status >= 500 ? "ERROR" : "INFO";
  process.stdout.write(`${JSON.stringify({severity, message: "oauth_mediator_request", ...entry})}\n`);
};

/**
 * Reduces an upstream error body to its OAuth error code, and only if it looks
 * like one. Anything else in the body is dropped rather than risk logging it.
 */
export function oauthErrorCode(body: string): string | undefined {
  try {
    const error: unknown = JSON.parse(body)?.error;
    return typeof error === "string" && /^[a-z_]{1,40}$/.test(error) ? error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sorts an upstream error body into {@link UpstreamErrorDetail} by the
 * reference authorization server's own wording (bluesky-social/atproto
 * `oauth-provider`). Only the name of the matching case is returned: a server
 * may put anything in its description, so the text itself goes nowhere.
 */
export function upstreamErrorDetail(body: string): UpstreamErrorDetail {
  let error: unknown;
  let description: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      ({error, error_description: description} = parsed as {error?: unknown; error_description?: unknown});
    }
  } catch {
    return "none";
  }
  const text = typeof description === "string" ? description.trim().toLowerCase() : "";
  if (text === "refresh token replayed") return "refresh_token_replayed";
  if (text === "session expired") return "session_expired";
  if (text === "refresh token expired") return "refresh_token_expired";
  if (text === "dpop proof replayed") return "dpop_proof_replayed";
  if (text.startsWith("failed to verify dpop proof")) return "dpop_proof_unverified";
  if (text === "invalid dpop key binding") return "dpop_key_binding";
  if (error === "invalid_dpop_proof") return "dpop_proof_other";
  return text === "" ? "none" : "other";
}

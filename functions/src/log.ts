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

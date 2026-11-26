/**
 * Every response says who produced it. The app clears a session only on an
 * `invalid_grant` that the authorization server itself issued, so a response
 * the backend made up must never be mistakable for one that was relayed.
 */
export const ORIGIN_HEADER = "Nubecita-Mediator-Origin";

/** Why the backend answered a request itself instead of relaying an answer. */
export const MEDIATOR_REASONS = [
  "not_found",
  "bypass",
  "attestation_required",
  "unknown_client",
  "unknown_key",
  "issuer_rejected",
  "rate_limited",
  "upstream_timeout",
  "upstream_unreachable",
  "in_progress",
  "internal",
] as const;

export type MediatorReason = (typeof MEDIATOR_REASONS)[number];

/**
 * Whether the request reached the authorization server. `"unknown"` means it
 * was sent and no answer came back: anything single-use it carried may be
 * spent.
 */
export type Forwarded = boolean | "unknown";

export interface MediatorResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * A response the backend produced itself. The `mediator_` prefix keeps every
 * reason outside the OAuth error namespace.
 */
export function mediatorError(status: number, reason: MediatorReason, forwarded: Forwarded): MediatorResponse {
  return {
    status,
    headers: {
      [ORIGIN_HEADER]: "mediator",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({error: `mediator_${reason}`, forwarded}),
  };
}

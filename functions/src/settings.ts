import {ENTRY_LIFETIME_MS} from "./replayStore";

/**
 * Switches an operator can flip on the running service without a code change
 * (by updating its environment), read on every request.
 */
export interface Settings {
  /** Answer every request "not forwarded, use the direct path" and contact no authorization server. */
  bypass: boolean;
  /** Refuse a sign-in that lacks a valid App Check token. Off = observe only. */
  enforceSignInAttestation: boolean;
  /** Also refuse a refresh or sign-out that lacks one. Off by default, on purpose. */
  strictRefreshAttestation: boolean;
  /**
   * Refuse a refresh whose refresh token the backend handed out less than this
   * many milliseconds ago. 0 = off. Meant for the hour around a change of the
   * client's registered auth method, when two refreshes of one session in
   * quick succession can land on authorization-server processes that disagree
   * about the client, which deletes the session.
   */
  minRefreshIntervalMs: number;
}

export type ReadSettings = () => Settings;

export const environmentSettings: ReadSettings = () => ({
  bypass: process.env["MEDIATOR_BYPASS"] === "true",
  enforceSignInAttestation: process.env["MEDIATOR_ENFORCE_SIGN_IN_ATTESTATION"] === "true",
  strictRefreshAttestation: process.env["MEDIATOR_STRICT_REFRESH_ATTESTATION"] === "true",
  minRefreshIntervalMs: minRefreshIntervalMs(process.env["MEDIATOR_MIN_REFRESH_INTERVAL_MINUTES"]),
});

/**
 * Reads the minimum refresh interval, given in minutes. Unset, empty or 0 is
 * off.
 *
 * Anything else that is not a usable number throws, which fails every request
 * with a retryable backend error until it is corrected. That is deliberate:
 * this guard is switched on to protect sessions, and a mistyped value that
 * silently left it off would not be noticed until sessions were lost.
 *
 * @throws Error when the value is not a number of minutes between 0 and 24 hours.
 */
export function minRefreshIntervalMs(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return 0;
  const minutes = Number(text);
  // The interval is measured against stored responses, which are kept for a day.
  if (!Number.isFinite(minutes) || minutes < 0 || minutes * 60_000 > ENTRY_LIFETIME_MS) {
    throw new Error("MEDIATOR_MIN_REFRESH_INTERVAL_MINUTES must be a number of minutes between 0 and 1440");
  }
  return minutes * 60_000;
}

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
}

export type ReadSettings = () => Settings;

export const environmentSettings: ReadSettings = () => ({
  bypass: process.env["MEDIATOR_BYPASS"] === "true",
  enforceSignInAttestation: process.env["MEDIATOR_ENFORCE_SIGN_IN_ATTESTATION"] === "true",
  strictRefreshAttestation: process.env["MEDIATOR_STRICT_REFRESH_ATTESTATION"] === "true",
});

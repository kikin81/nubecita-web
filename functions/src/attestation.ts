import type {Settings} from "./settings";

/** What the attestation check concluded about a request's App Check token. */
export type AttestationVerdict = "valid" | "missing" | "invalid";

export type VerifyAttestation = (token: string | undefined) => Promise<AttestationVerdict>;

/** The four requests the backend mediates. */
export type RequestKind = "par" | "code_exchange" | "refresh" | "revoke";

/**
 * Whether a request may go ahead given its attestation verdict.
 *
 * Sign-in is where attestation matters: it stops another app from completing
 * a sign-in as this client. A refresh or sign-out already requires the
 * session's current token and the device's DPoP key, so by default those are
 * recorded and never blocked — an attestation outage must not stall a
 * signed-in user.
 */
export function mayProceed(kind: RequestKind, verdict: AttestationVerdict, settings: Settings): boolean {
  if (verdict === "valid") return true;
  const signIn = kind === "par" || kind === "code_exchange";
  return signIn ? !settings.enforceSignInAttestation : !settings.strictRefreshAttestation;
}

/**
 * Wraps a token verifier so that nothing it does can fail a request: no
 * token is "missing", and any verification error is "invalid".
 */
export function attestationVerifier(verifyToken: (token: string) => Promise<unknown>): VerifyAttestation {
  return async (token) => {
    if (token === undefined || token.trim() === "") return "missing";
    try {
      await verifyToken(token);
      return "valid";
    } catch {
      return "invalid";
    }
  };
}

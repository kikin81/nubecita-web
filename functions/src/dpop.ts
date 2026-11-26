import {createHash, createPublicKey, verify as verifySignature} from "node:crypto";

/**
 * Reading a device's DPoP proof (RFC 9449). The backend never makes or alters
 * a proof; it only needs to tell whether a request comes from the holder of a
 * particular key, before handing back a response it stored for that key.
 *
 * Only ES256 on P-256 is understood: it is what the app signs with. A proof
 * made any other way is simply not recognised.
 */

/** How far a proof's `iat` may be from this server's clock, either way. */
export const PROOF_MAX_AGE_MS = 5 * 60_000;

interface ParsedProof {
  /** RFC 7638 thumbprint of the key embedded in the proof. */
  jkt: string;
  x: string;
  y: string;
  signingInput: string;
  signature: Buffer;
  claims: Record<string, unknown>;
}

function parse(proof: string): ParsedProof | undefined {
  const parts = proof.split(".");
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  try {
    const header = object(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")));
    const claims = object(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")));
    const jwk = object(header?.["jwk"]);
    if (header === undefined || claims === undefined || jwk === undefined) return undefined;
    if (header["typ"] !== "dpop+jwt" || header["alg"] !== "ES256") return undefined;
    const {kty, crv, x, y} = jwk;
    if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string") return undefined;
    // A proof carries a public key. One that also carries the private half is not a proof.
    if ("d" in jwk) return undefined;
    return {
      // The members RFC 7638 requires for an EC key, in its order, and nothing else.
      jkt: createHash("sha256").update(JSON.stringify({crv, kty, x, y})).digest("base64url"),
      x,
      y,
      signingInput: `${encodedHeader}.${encodedClaims}`,
      signature: Buffer.from(encodedSignature, "base64url"),
      claims,
    };
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The thumbprint of the key a proof was made with, without checking the
 * proof. Used for a request the authorization server has just accepted, which
 * is all the checking that proof needs.
 */
export function proofKeyThumbprint(proof: string): string | undefined {
  return parse(proof)?.jkt;
}

/** `htu` is compared without query or fragment, as RFC 9449 says. */
function target(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * True when `proof` is a genuine, recent proof for a POST to `htu`, signed by
 * the key whose thumbprint is `jkt`.
 */
export function isProofFor(proof: string, expected: {jkt: string; htu: string; nowMs: number}): boolean {
  const parsed = parse(proof);
  if (parsed === undefined || parsed.jkt !== expected.jkt) return false;

  const {htm, htu, iat, jti} = parsed.claims;
  if (htm !== "POST") return false;
  const wanted = target(expected.htu);
  if (wanted === undefined || target(htu) !== wanted) return false;
  if (typeof jti !== "string" || jti === "") return false;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return false;
  if (Math.abs(expected.nowMs - iat * 1000) > PROOF_MAX_AGE_MS) return false;

  try {
    const key = createPublicKey({key: {kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y}, format: "jwk"});
    return verifySignature("sha256", Buffer.from(parsed.signingInput, "ascii"), {key, dsaEncoding: "ieee-p1363"}, parsed.signature);
  } catch {
    return false;
  }
}

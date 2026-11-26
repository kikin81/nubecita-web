import {createPublicKey} from "node:crypto";

/** The public half of a client signing key, as published in client metadata. */
export interface PublicSigningJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

/**
 * Converts a PEM public key (as Cloud KMS exports it) into the JWK that goes
 * in a client metadata file's `jwks`. Only ever emits public fields.
 */
export function publicJwkFromPem(pem: string, kid: string): PublicSigningJwk {
  if (kid.trim() === "") throw new Error("kid must not be empty");
  // createPublicKey derives the public key if it is handed a private one.
  const jwk = createPublicKey(pem).export({format: "jwk"});
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error(`Client signing keys must be EC P-256 (got ${jwk.kty ?? "?"} ${jwk.crv ?? ""})`.trim());
  }
  return {kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig"};
}

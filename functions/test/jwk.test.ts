import {createPublicKey, generateKeyPairSync} from "node:crypto";
import {describe, expect, it} from "vitest";
import {publicJwkFromPem} from "../src/jwk";

function pem(curve: string): string {
  return generateKeyPairSync("ec", {namedCurve: curve}).publicKey.export({type: "spki", format: "pem"}).toString();
}

describe("publicJwkFromPem", () => {
  it("turns a P-256 public key into an ES256 signing JWK with its key id", () => {
    const source = pem("P-256");

    const jwk = publicJwkFromPem(source, "test-1");

    expect(jwk).toMatchObject({kty: "EC", crv: "P-256", kid: "test-1", alg: "ES256", use: "sig"});
    expect(Object.keys(jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    // Same key: importing the JWK gives back the PEM we started from.
    const roundTripped = createPublicKey({key: {kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y}, format: "jwk"})
      .export({type: "spki", format: "pem"})
      .toString();
    expect(roundTripped).toBe(source);
  });

  it("never carries private key material", () => {
    const privatePem = generateKeyPairSync("ec", {namedCurve: "P-256"})
      .privateKey.export({type: "pkcs8", format: "pem"})
      .toString();

    // Given a private key by mistake, only its public half comes out.
    expect(publicJwkFromPem(privatePem, "k")).not.toHaveProperty("d");
  });

  it("refuses a key that is not P-256", () => {
    expect(() => publicJwkFromPem(pem("P-384"), "k")).toThrow(/P-256/);
    const rsa = generateKeyPairSync("rsa", {modulusLength: 2048}).publicKey.export({type: "spki", format: "pem"});
    expect(() => publicJwkFromPem(rsa.toString(), "k")).toThrow(/P-256/);
  });

  it("refuses an empty key id", () => {
    expect(() => publicJwkFromPem(pem("P-256"), " ")).toThrow(/kid/);
  });
});

import {describe, expect, it} from "vitest";
import {PROOF_MAX_AGE_MS, isProofFor, proofKeyThumbprint} from "../src/dpop";
import {DEVICE, START, TOKEN_ENDPOINT, deviceKey, dpopProof} from "./proofs";

const jkt = proofKeyThumbprint(dpopProof()) ?? "";
const expected = {jkt, htu: TOKEN_ENDPOINT, nowMs: START};

describe("the key thumbprint", () => {
  it("is the RFC 7638 thumbprint of the embedded key (the example key from RFC 9449)", () => {
    const header = {
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: {
        kty: "EC",
        x: "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
        y: "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA",
        crv: "P-256",
      },
    };
    const proof = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.AA`;

    expect(proofKeyThumbprint(proof)).toBe("0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I");
  });

  it("is the same for every proof from one key and differs between keys", () => {
    expect(proofKeyThumbprint(dpopProof())).toBe(jkt);
    expect(proofKeyThumbprint(dpopProof({key: deviceKey()}))).not.toBe(jkt);
  });

  it.each([
    ["not a JWT", "nonsense"],
    ["an empty string", ""],
    ["a header that is not JSON", "bm90IGpzb24.e30.AA"],
    ["another type", dpopProof({header: {typ: "JWT"}})],
    ["another algorithm", dpopProof({header: {alg: "none"}})],
    ["a symmetric algorithm", dpopProof({header: {alg: "HS256"}})],
    ["no key", dpopProof({header: {jwk: undefined}})],
    ["a key on another curve", dpopProof({header: {jwk: {...DEVICE.jwk, crv: "P-384"}}})],
    ["a key that includes its private half", dpopProof({header: {jwk: {...DEVICE.jwk, d: "AAAA"}}})],
  ])("does not read %s", (_label, proof) => {
    expect(proofKeyThumbprint(proof)).toBeUndefined();
  });
});

describe("checking a proof", () => {
  it("accepts a fresh proof for the endpoint from the expected key", () => {
    expect(isProofFor(dpopProof(), expected)).toBe(true);
  });

  it("ignores a query or fragment on the target, as RFC 9449 says", () => {
    expect(isProofFor(dpopProof({htu: `${TOKEN_ENDPOINT}?x=1#y`}), expected)).toBe(true);
  });

  it("rejects a proof from another key", () => {
    expect(isProofFor(dpopProof({key: deviceKey()}), expected)).toBe(false);
  });

  it("rejects a proof that names the expected key but was signed with another", () => {
    const forged = dpopProof({key: {privateKey: deviceKey().privateKey, jwk: DEVICE.jwk}});

    expect(proofKeyThumbprint(forged)).toBe(jkt);
    expect(isProofFor(forged, expected)).toBe(false);
  });

  it("rejects a proof whose claims were changed after signing", () => {
    const [header, , signature] = dpopProof({atMs: START - 60 * 60_000}).split(".");
    const [, freshClaims] = dpopProof().split(".");

    expect(isProofFor(`${header}.${freshClaims}.${signature}`, expected)).toBe(false);
  });

  it.each([
    ["another endpoint", dpopProof({htu: "https://auth.test/oauth/par"})],
    ["another server", dpopProof({htu: "https://other.test/oauth/token"})],
    ["a target that is not a URL", dpopProof({htu: "token"})],
    ["another method", dpopProof({htm: "GET"})],
    ["no jti", dpopProof({claims: {jti: undefined}})],
    ["no iat", dpopProof({claims: {iat: undefined}})],
    ["an iat that is not a number", dpopProof({claims: {iat: "now"}})],
    ["a truncated signature", dpopProof().slice(0, -8)],
  ])("rejects a proof with %s", (_label, proof) => {
    expect(isProofFor(proof, expected)).toBe(false);
  });

  it("accepts a proof up to five minutes old or ahead, and none beyond", () => {
    expect(isProofFor(dpopProof({atMs: START - PROOF_MAX_AGE_MS}), expected)).toBe(true);
    expect(isProofFor(dpopProof({atMs: START + PROOF_MAX_AGE_MS}), expected)).toBe(true);
    expect(isProofFor(dpopProof({atMs: START - PROOF_MAX_AGE_MS - 1000}), expected)).toBe(false);
    expect(isProofFor(dpopProof({atMs: START + PROOF_MAX_AGE_MS + 1000}), expected)).toBe(false);
  });
});

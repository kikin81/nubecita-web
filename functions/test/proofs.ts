import {type KeyObject, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign} from "node:crypto";

export const ISSUER = "https://auth.test";
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
/** The moment every test clock starts at. */
export const START = 1_795_000_000_000;

/** A token as an authorization server makes them: 256 random bits. Made fresh so no test shares one. */
export const newToken = (prefix = "ref"): string => `${prefix}-${randomBytes(32).toString("base64url")}`;

/** A device's DPoP key. */
export interface DeviceKey {
  privateKey: KeyObject;
  jwk: {kty: string; crv: string; x: string; y: string};
}

export function deviceKey(): DeviceKey {
  const pair = generateKeyPairSync("ec", {namedCurve: "P-256"});
  const {kty, crv, x, y} = pair.publicKey.export({format: "jwk"});
  return {privateKey: pair.privateKey, jwk: {kty: kty ?? "", crv: crv ?? "", x: x ?? "", y: y ?? ""}};
}

export const DEVICE = deviceKey();

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A DPoP proof as the app makes them: ES256, the public key embedded, the token endpoint as target. */
export function dpopProof(
  options: {
    key?: DeviceKey;
    atMs?: number;
    htu?: string;
    htm?: string;
    header?: Record<string, unknown>;
    claims?: Record<string, unknown>;
  } = {},
): string {
  const key = options.key ?? DEVICE;
  const header = encode({typ: "dpop+jwt", alg: "ES256", jwk: key.jwk, ...options.header});
  const claims = encode({
    jti: randomUUID(),
    htm: options.htm ?? "POST",
    htu: options.htu ?? TOKEN_ENDPOINT,
    iat: Math.floor((options.atMs ?? START) / 1000),
    ...options.claims,
  });
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${claims}`), {key: key.privateKey, dsaEncoding: "ieee-p1363"});
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

/**
 * Fails if any eight consecutive characters of a token appear in `written`.
 * Eight is short enough that no usable part of a token could slip through and
 * long enough not to match random bytes by accident.
 */
export function tokenTraces(written: string, tokens: readonly string[]): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    for (let start = 0; start + 8 <= token.length; start++) {
      const piece = token.slice(start, start + 8);
      if (written.includes(piece)) found.push(piece);
    }
  }
  return found;
}

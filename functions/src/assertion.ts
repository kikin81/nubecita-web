/**
 * Client authentication for a confidential OAuth client: a short-lived JWT,
 * signed with the client's key, that the authorization server checks against
 * the public key in the client's published metadata (RFC 7523,
 * `private_key_jwt`).
 */

/**
 * Produces ECDSA P-256 / SHA-256 signatures with a named client key. The key
 * itself stays wherever the signer keeps it; this module never sees it.
 */
export interface Signer {
  /** Signs `signingInput` and returns the signature DER-encoded, as Cloud KMS does. */
  signDer(kid: string, signingInput: Uint8Array): Promise<Uint8Array>;
}

export interface AssertionInput {
  /** The client's `client_id`: the URL of its metadata document. */
  clientId: string;
  /** The authorization server's issuer identifier. */
  issuer: string;
  /** Which of the client's keys to sign with. */
  kid: string;
  nowSeconds: number;
  /** Must never repeat: the server rejects a reused value as `invalid_grant`. */
  jti: string;
}

/** The server accepts an assertion for at most a minute after `iat`. */
const LIFETIME_SECONDS = 60;

export async function mintClientAssertion(input: AssertionInput, signer: Signer): Promise<string> {
  const header = encode({alg: "ES256", typ: "JWT", kid: input.kid});
  const payload = encode({
    iss: input.clientId,
    sub: input.clientId,
    aud: input.issuer,
    iat: input.nowSeconds,
    exp: input.nowSeconds + LIFETIME_SECONDS,
    jti: input.jti,
  });
  const signingInput = `${header}.${payload}`;
  const der = await signer.signDer(input.kid, Buffer.from(signingInput, "ascii"));
  return `${signingInput}.${Buffer.from(derToJose(der)).toString("base64url")}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const COORDINATE_BYTES = 32;

/**
 * Converts a DER-encoded ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`)
 * to the fixed-width `r || s` form JWS requires for ES256.
 */
export function derToJose(der: Uint8Array): Uint8Array {
  let offset = 0;
  const byte = (): number => {
    const value = der[offset++];
    if (value === undefined) throw new Error("Malformed DER signature: truncated");
    return value;
  };
  const length = (): number => {
    const first = byte();
    // P-256 signatures are far below 128 bytes, so only the short form is valid here.
    if (first >= 0x80) throw new Error("Malformed DER signature: unexpected length form");
    return first;
  };
  const integer = (): Uint8Array => {
    if (byte() !== 0x02) throw new Error("Malformed DER signature: expected INTEGER");
    const size = length();
    if (size === 0 || offset + size > der.length) throw new Error("Malformed DER signature: bad INTEGER length");
    let value = der.subarray(offset, offset + size);
    offset += size;
    // A leading zero only says "this is positive"; it is not part of the number.
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > COORDINATE_BYTES) throw new Error("Malformed DER signature: INTEGER too large for P-256");
    return value;
  };

  if (byte() !== 0x30) throw new Error("Malformed DER signature: expected SEQUENCE");
  const sequenceLength = length();
  if (offset + sequenceLength !== der.length) throw new Error("Malformed DER signature: length mismatch");
  const r = integer();
  const s = integer();
  if (offset !== der.length) throw new Error("Malformed DER signature: trailing bytes");

  const jose = new Uint8Array(COORDINATE_BYTES * 2);
  jose.set(r, COORDINATE_BYTES - r.length);
  jose.set(s, COORDINATE_BYTES * 2 - s.length);
  return jose;
}

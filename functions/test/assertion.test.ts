import {type KeyObject, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify} from "node:crypto";
import {describe, expect, it} from "vitest";
import {type Signer, derToJose, mintClientAssertion} from "../src/assertion";

const {privateKey, publicKey} = generateKeyPairSync("ec", {namedCurve: "P-256"});

/** Signs locally the way Cloud KMS does: SHA-256, DER-encoded ECDSA. */
function localSigner(key: KeyObject, calls: string[] = []): Signer {
  return {
    async signDer(kid, signingInput) {
      calls.push(kid);
      return cryptoSign("sha256", signingInput, {key, dsaEncoding: "der"});
    },
  };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

const input = {
  clientId: "https://nubecita.app/oauth/client-metadata.json",
  issuer: "https://bsky.social",
  kid: "prod-1",
  nowSeconds: 1_795_000_000,
  jti: "jti-1",
};

describe("mintClientAssertion", () => {
  it("names the client as issuer and subject, the authorization server as audience, and expires within a minute", async () => {
    const jwt = await mintClientAssertion(input, localSigner(privateKey));
    const [header, payload] = jwt.split(".");

    expect(decode(header!)).toEqual({alg: "ES256", typ: "JWT", kid: "prod-1"});
    expect(decode(payload!)).toEqual({
      iss: input.clientId,
      sub: input.clientId,
      aud: "https://bsky.social",
      iat: 1_795_000_000,
      exp: 1_795_000_060,
      jti: "jti-1",
    });
  });

  it("is a valid ES256 signature over header.payload in JOSE form", async () => {
    const jwt = await mintClientAssertion(input, localSigner(privateKey));
    const [header, payload, signature] = jwt.split(".");
    const raw = Buffer.from(signature!, "base64url");

    expect(raw).toHaveLength(64);
    expect(
      cryptoVerify("sha256", Buffer.from(`${header}.${payload}`), {key: publicKey, dsaEncoding: "ieee-p1363"}, raw),
    ).toBe(true);
  });

  it("asks the signer for exactly the key that was named", async () => {
    const calls: string[] = [];

    await mintClientAssertion({...input, kid: "test-1"}, localSigner(privateKey, calls));

    expect(calls).toEqual(["test-1"]);
  });

  it("uses unpadded base64url throughout", async () => {
    const jwt = await mintClientAssertion(input, localSigner(privateKey));

    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("derToJose", () => {
  it("converts every DER signature to a verifying 64-byte one, whatever the integer lengths", () => {
    // r and s are each sometimes shorter than 32 bytes and sometimes carry a
    // leading zero byte; enough signatures hit all of those shapes.
    const message = Buffer.from("header.payload");
    const derLengths = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const der = cryptoSign("sha256", message, {key: privateKey, dsaEncoding: "der"});
      derLengths.add(der.length);

      const jose = derToJose(der);

      expect(jose).toHaveLength(64);
      expect(cryptoVerify("sha256", message, {key: publicKey, dsaEncoding: "ieee-p1363"}, jose)).toBe(true);
    }
    expect(derLengths.size).toBeGreaterThan(1);
  });

  it("left-pads a short integer", () => {
    // SEQUENCE { INTEGER 0x01, INTEGER 0x02 }
    const jose = derToJose(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]));

    expect(jose[31]).toBe(1);
    expect(jose[63]).toBe(2);
    expect(jose.filter((byte) => byte !== 0)).toHaveLength(2);
  });

  it.each([
    ["not a sequence", [0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]],
    ["truncated", [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]],
    ["trailing bytes", [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00]],
    ["an integer that is too long", [0x30, 0x26, 0x02, 0x22, 0x01, ...new Array(33).fill(0xff), 0x02, 0x01, 0x02]],
    ["empty", []],
  ])("refuses a signature that is %s", (_label, bytes) => {
    expect(() => derToJose(Uint8Array.from(bytes as number[]))).toThrow();
  });
});

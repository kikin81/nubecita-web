import {describe, expect, it} from "vitest";
import {type ReplayPayload, entryId, issuedMark, issuedRefreshToken, open, seal} from "../src/replayCrypto";
import {newToken, tokenTraces} from "./proofs";

const TOKEN = newToken();
const NEW_TOKENS = {access_token: newToken("at"), refresh_token: newToken()};
const payload: ReplayPayload = {
  status: 200,
  body: JSON.stringify(NEW_TOKENS),
  contentType: "application/json",
  dpopNonce: "nonce-1",
  kid: "test-2",
  authMethod: "private_key_jwt",
  jkt: "thumbprint",
  htu: "https://auth.test/oauth/token",
};

describe("entry names", () => {
  it("are a fixed-length hash that is the same every time and differs per token", () => {
    expect(entryId(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(entryId(TOKEN)).toBe(entryId(TOKEN));
    expect(entryId(TOKEN)).not.toBe(entryId(`${TOKEN}x`));
  });

  it("cannot be linked to the mark left for the same token by the entry that issued it", () => {
    expect(issuedMark(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(issuedMark(TOKEN)).not.toBe(entryId(TOKEN));
  });
});

describe("sealing a response", () => {
  it("gives the response back to whoever presents the refresh token it answers", () => {
    const id = entryId(TOKEN);

    expect(open(TOKEN, id, seal(TOKEN, id, payload))).toEqual(payload);
  });

  it("uses a fresh salt and nonce every time", () => {
    const id = entryId(TOKEN);
    const [first, second] = [seal(TOKEN, id, payload), seal(TOKEN, id, payload)];

    expect(Buffer.from(first.salt)).not.toEqual(Buffer.from(second.salt));
    expect(Buffer.from(first.iv)).not.toEqual(Buffer.from(second.iv));
    expect(Buffer.from(first.ciphertext)).not.toEqual(Buffer.from(second.ciphertext));
  });

  it("gives nothing for another refresh token", () => {
    const id = entryId(TOKEN);

    expect(open(NEW_TOKENS.refresh_token, id, seal(TOKEN, id, payload))).toBeUndefined();
  });

  it("gives nothing when moved under another entry's name", () => {
    expect(open(TOKEN, entryId("another"), seal(TOKEN, entryId(TOKEN), payload))).toBeUndefined();
  });

  it("gives nothing once a single bit is changed", () => {
    const id = entryId(TOKEN);
    const sealed = seal(TOKEN, id, payload);
    const ciphertext = Buffer.from(sealed.ciphertext);
    ciphertext[5] = (ciphertext[5] ?? 0) ^ 1;

    expect(open(TOKEN, id, {...sealed, ciphertext})).toBeUndefined();
    expect(open(TOKEN, id, {...sealed, ciphertext: new Uint8Array(4)})).toBeUndefined();
  });

  it("leaves no part of any token in what is stored", () => {
    const id = entryId(TOKEN);
    const sealed = seal(TOKEN, id, payload);
    const mark = issuedMark(NEW_TOKENS.refresh_token);
    const bytes = Buffer.concat([sealed.salt, sealed.iv, sealed.ciphertext]);
    const written = [id, mark, bytes.toString("latin1"), bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex")].join("\n");

    expect(tokenTraces(written, [TOKEN, NEW_TOKENS.access_token, NEW_TOKENS.refresh_token])).toEqual([]);
  });
});

describe("the issued refresh token", () => {
  it("is read from a token response", () => {
    expect(issuedRefreshToken(JSON.stringify(NEW_TOKENS))).toBe(NEW_TOKENS.refresh_token);
  });

  it.each([["{}"], ['{"refresh_token": 7}'], ['{"refresh_token": ""}'], ["not json"], ["null"]])("is absent from %s", (body) => {
    expect(issuedRefreshToken(body)).toBeUndefined();
  });
});

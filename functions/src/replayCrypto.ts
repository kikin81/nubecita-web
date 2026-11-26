import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from "node:crypto";
import type {SealedResponse} from "./replayStore";

/**
 * Everything the replay store keeps is derived from a refresh token in a way
 * that cannot be undone, or encrypted under a key that only the token yields.
 * A refresh token is 256 bits of randomness, so neither a hash of it nor a
 * key derived from it can be guessed. Someone holding the whole database and
 * nothing else learns nothing they can use.
 */

const ID_CONTEXT = "nubecita:refresh-replay:v1:id:";
const ISSUED_CONTEXT = "nubecita:refresh-replay:v1:issued:";
const KEY_CONTEXT = "nubecita:refresh-replay:v1:key";

const hash = (context: string, token: string): string => createHash("sha256").update(context).update(token).digest("hex");

/** The name of the entry that answers `refreshToken`. */
export const entryId = (refreshToken: string): string => hash(ID_CONTEXT, refreshToken);

/**
 * The mark an entry carries for the refresh token its response handed out.
 * Deliberately not that token's own entry id, so two entries cannot be linked
 * to one session by reading the database.
 */
export const issuedMark = (refreshToken: string): string => hash(ISSUED_CONTEXT, refreshToken);

/** What is needed to answer a retry exactly as the first attempt was answered. */
export interface ReplayPayload {
  status: number;
  body: string;
  contentType?: string;
  dpopNonce?: string;
  /** The key the client assertion was signed with. */
  kid: string;
  /** The client's registered auth method, as reported with the original answer. */
  authMethod?: string;
  /** Thumbprint of the DPoP key the refresh was made with. Only its holder gets the response. */
  jkt: string;
  /** The token endpoint the refresh was sent to. */
  htu: string;
}

const key = (refreshToken: string, salt: Uint8Array): Buffer =>
  Buffer.from(hkdfSync("sha256", Buffer.from(refreshToken, "utf8"), salt, KEY_CONTEXT, 32));

const TAG_BYTES = 16;

/** Encrypts a response under a key derived from the refresh token it answers. */
export function seal(refreshToken: string, id: string, payload: ReplayPayload): SealedResponse {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(refreshToken, salt), iv);
  // Ties the ciphertext to its entry: it cannot be moved under another name.
  cipher.setAAD(Buffer.from(id, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {salt, iv, ciphertext};
}

/** The stored response, or nothing if it cannot be decrypted with this refresh token. */
export function open(refreshToken: string, id: string, sealed: SealedResponse): ReplayPayload | undefined {
  try {
    const data = Buffer.from(sealed.ciphertext);
    if (data.length <= TAG_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key(refreshToken, sealed.salt), sealed.iv);
    decipher.setAAD(Buffer.from(id, "utf8"));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
    const payload = JSON.parse(plain.toString("utf8")) as ReplayPayload;
    if (
      typeof payload.status !== "number" ||
      typeof payload.body !== "string" ||
      typeof payload.kid !== "string" ||
      typeof payload.jkt !== "string" ||
      typeof payload.htu !== "string"
    ) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

/** The refresh token a successful token response hands out, if it can be read. */
export function issuedRefreshToken(body: string): string | undefined {
  try {
    const token: unknown = JSON.parse(body)?.refresh_token;
    return typeof token === "string" && token !== "" ? token : undefined;
  } catch {
    return undefined;
  }
}

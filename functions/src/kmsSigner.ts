import {createHash} from "node:crypto";
import {KeyManagementServiceClient} from "@google-cloud/kms";
import type {Signer} from "./assertion";
import type {ClientConfig} from "./clients";

const SIGN_TIMEOUT_MS = 5_000;

/**
 * Signs with keys held in Cloud KMS. The private keys are generated there and
 * cannot be exported: this process only ever sends a digest and receives a
 * signature.
 */
export function kmsSigner(clients: readonly ClientConfig[]): Signer {
  const keyVersions = keyVersionsByKid(clients);
  let client: KeyManagementServiceClient | undefined;

  return {
    async signDer(kid, signingInput) {
      const name = keyVersions.get(kid);
      if (name === undefined) throw new Error("No key version for the requested key id");
      client ??= new KeyManagementServiceClient();
      const digest = createHash("sha256").update(signingInput).digest();
      const [result] = await client.asymmetricSign({name, digest: {sha256: digest}}, {timeout: SIGN_TIMEOUT_MS});
      const signature = result.signature;
      if (signature === undefined || signature === null || signature.length === 0) {
        throw new Error("Key service returned no signature");
      }
      return typeof signature === "string" ? Buffer.from(signature, "base64") : signature;
    },
  };
}

/**
 * Key ids must be unique across clients, because a session's key id alone
 * decides which key signs for it.
 */
export function keyVersionsByKid(clients: readonly ClientConfig[]): Map<string, string> {
  const keyVersions = new Map<string, string>();
  for (const client of clients) {
    if (!Object.hasOwn(client.keys, client.defaultKid)) {
      throw new Error(`Client ${client.clientId} has a default key id it holds no key for`);
    }
    for (const [kid, name] of Object.entries(client.keys)) {
      if (keyVersions.has(kid)) throw new Error(`Key id ${kid} is used by more than one client`);
      keyVersions.set(kid, name);
    }
  }
  return keyVersions;
}

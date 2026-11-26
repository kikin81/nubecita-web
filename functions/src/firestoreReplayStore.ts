import {randomUUID} from "node:crypto";
import {type DocumentData, type Firestore, Timestamp} from "firebase-admin/firestore";
import {type Claim, type ReplayStore, type StoredResponse, CLAIM_WINDOW_MS, ENTRY_LIFETIME_MS} from "./replayStore";

/**
 * The replay store in Firestore: one document per refresh token, named by a
 * hash of it.
 *
 *   state      "pending" while a forward is in flight, "done" once answered
 *   at         when that state began, in milliseconds
 *   lease      (pending) names the attempt that holds the claim
 *   salt, iv, ciphertext   (done) the encrypted response
 *   issued     (done) mark of the refresh token the response handed out
 *   expireAt   when Firestore's TTL policy may delete the document
 *
 * Expiry is decided here, on read, from `at`. The TTL policy only clears up
 * afterwards, and can run a day late.
 */
export function firestoreReplayStore(
  database: () => Firestore,
  collection: string,
  newLease: () => string = randomUUID,
): ReplayStore {
  const entries = () => database().collection(collection);
  const expireAt = (now: number): Timestamp => Timestamp.fromMillis(now + ENTRY_LIFETIME_MS);

  return {
    async read(id, now) {
      return stored((await entries().doc(id).get()).data(), now);
    },

    async claim(id, now) {
      const reference = entries().doc(id);
      const lease = newLease();
      const pending = {state: "pending", at: now, lease, expireAt: expireAt(now)};
      // Nearly every refresh token is being seen for the first time. Creating
      // its entry succeeds for exactly one caller, with no lock for the
      // others to queue behind.
      try {
        await reference.create(pending);
        return {outcome: "claimed", lease};
      } catch (error) {
        if (!alreadyExists(error)) throw error;
      }
      // Something is there already: decide what it means, and take it over if
      // it is stale, in one transaction.
      return database().runTransaction<Claim>(async (transaction) => {
        const data = (await transaction.get(reference)).data();
        const response = stored(data, now);
        if (response !== undefined) return {outcome: "stored", response};
        if (data?.["state"] === "pending" && typeof data["at"] === "number" && now - data["at"] < CLAIM_WINDOW_MS) {
          return {outcome: "in_progress"};
        }
        // Only what an attempt that has certainly ended left behind, or an expired answer.
        transaction.set(reference, pending);
        return {outcome: "claimed", lease};
      });
    },

    async complete(id, sealed, issued, now) {
      // Unconditional: an answer from the authorization server is the truth
      // about this refresh token, whatever the entry said before.
      await entries()
        .doc(id)
        .set({
          state: "done",
          at: now,
          salt: Buffer.from(sealed.salt),
          iv: Buffer.from(sealed.iv),
          ciphertext: Buffer.from(sealed.ciphertext),
          ...(issued === undefined ? {} : {issued}),
          expireAt: expireAt(now),
        });
    },

    async release(id, lease) {
      const reference = entries().doc(id);
      await database().runTransaction(async (transaction) => {
        const data = (await transaction.get(reference)).data();
        if (data?.["state"] === "pending" && data["lease"] === lease) transaction.delete(reference);
      });
    },

    async issuedBy(issued, now) {
      const found = await entries().where("issued", "==", issued).limit(1).get();
      const document = found.docs[0];
      const response = stored(document?.data(), now);
      return document === undefined || response === undefined ? undefined : {id: document.id, storedAt: response.storedAt};
    },

    async remove(id) {
      await entries().doc(id).delete();
    },
  };
}

/** gRPC status ALREADY_EXISTS, which is how Firestore refuses to create a document that is there. */
function alreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as {code?: unknown}).code === 6;
}

/** A document as a stored response, if it is one and has not expired. */
function stored(data: DocumentData | undefined, now: number): StoredResponse | undefined {
  if (data === undefined || data["state"] !== "done") return undefined;
  const {at, salt, iv, ciphertext} = data;
  if (typeof at !== "number" || now - at >= ENTRY_LIFETIME_MS) return undefined;
  if (!(salt instanceof Uint8Array) || !(iv instanceof Uint8Array) || !(ciphertext instanceof Uint8Array)) return undefined;
  return {sealed: {salt, iv, ciphertext}, storedAt: at};
}

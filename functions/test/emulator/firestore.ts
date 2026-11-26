import {randomUUID} from "node:crypto";
import {deleteApp, initializeApp} from "firebase-admin/app";
import {type Firestore, initializeFirestore} from "firebase-admin/firestore";
import {REPLAY_COLLECTION, REPLAY_DATABASE} from "../../src/config";
import {firestoreReplayStore} from "../../src/firestoreReplayStore";

const host = process.env["FIRESTORE_EMULATOR_HOST"];
const project = process.env["GCLOUD_PROJECT"] ?? "demo-nubecita";
if (host === undefined) throw new Error("These tests need the Firestore emulator: run `npm run test:emulator`.");

/**
 * Two separate connections to the emulated replay database, opened exactly as
 * the deployed function opens its own. The second stands in for another
 * instance of the function.
 */
export function emulatedStores() {
  const apps = [initializeApp({projectId: project}, randomUUID()), initializeApp({projectId: project}, randomUUID())];
  const [database, otherDatabase] = apps.map((app) => initializeFirestore(app, {preferRest: true}, REPLAY_DATABASE)) as [
    Firestore,
    Firestore,
  ];
  return {
    database,
    store: firestoreReplayStore(() => database, REPLAY_COLLECTION),
    otherStore: firestoreReplayStore(() => otherDatabase, REPLAY_COLLECTION),
    close: () => Promise.all(apps.map((app) => deleteApp(app))),
  };
}

/** The replay collection over REST, where a request without credentials is a client's. */
export const DOCUMENTS = `http://${host}/v1/projects/${project}/databases/${REPLAY_DATABASE}/documents/${REPLAY_COLLECTION}`;

/** A document as the database holds it, fetched with the emulator's admin bypass. */
export async function rawDocument(id: string): Promise<string> {
  const response = await fetch(`${DOCUMENTS}/${id}`, {headers: {authorization: "Bearer owner"}});
  if (response.status !== 200) throw new Error(`no such document (${response.status})`);
  return response.text();
}

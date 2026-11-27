/** Deployment settings that are not secret. */

import type {ClientConfig} from "./clients";

/** Firebase / Google Cloud project that hosts the backend. */
export const PROJECT_ID = "nubecita-2a4c1";

/**
 * Region the function runs in. Apps reach it through auth.nubecita.app, so
 * this can change without an app release.
 */
export const REGION = "us-central1";

/** Identity the function runs as: may sign with the client keys, nothing more. */
export const RUNTIME_SERVICE_ACCOUNT = `oauth-mediator@${PROJECT_ID}.iam.gserviceaccount.com`;

/**
 * The function must always answer before the app's own request timeout
 * (40 s for mediated requests), so the app learns the outcome instead of
 * guessing: upstream wait < function timeout < app timeout.
 */
export const FUNCTION_TIMEOUT_SECONDS = 30;

const KEY_RING = `projects/${PROJECT_ID}/locations/us/keyRings/oauth-client-auth`;
const keyVersion = (key: string, version: number): string => `${KEY_RING}/cryptoKeys/${key}/cryptoKeyVersions/${version}`;

/**
 * The OAuth clients this backend authenticates for. Each `clientId` is the URL
 * of a metadata file in this repository's `oauth/` directory, and each key id
 * must match a `kid` published in that file's `jwks`.
 *
 * Adding a key: add it here and to the metadata file, then make it the
 * default. NEVER remove a key while a session bound to it may still be alive
 * (two years after it stopped being the default): removing it signs those
 * users out.
 */
export const CLIENTS: readonly ClientConfig[] = [
  {
    clientId: "https://nubecita.app/oauth/client-metadata.json",
    defaultKid: "prod-1",
    keys: {"prod-1": keyVersion("nubecita-prod", 1)},
  },
  {
    clientId: "https://nubecita.app/oauth/client-metadata-test.json",
    defaultKid: "test-1",
    keys: {"test-1": keyVersion("nubecita-test", 1)},
  },
  {
    clientId: "https://nubecita.app/oauth/client-metadata-rehearsal.json",
    defaultKid: "rehearsal-1",
    keys: {"rehearsal-1": keyVersion("nubecita-rehearsal", 1)},
  },
];

/**
 * Where refresh responses are remembered (functions/src/replayStore.ts): a
 * Firestore database of its own, holding this one collection, so the runtime
 * identity can be granted that database and nothing else.
 */
export const REPLAY_DATABASE = "oauth-replay";
export const REPLAY_COLLECTION = "refreshReplay";

/** Sign-in starts allowed per caller address in each window. */
export const SIGN_IN_START_LIMIT = 10;
export const SIGN_IN_START_WINDOW_MS = 5 * 60_000;

/**
 * Sign-in starts allowed per *connecting* address in the same window. Far
 * above what real users produce even when many share one proxy address, and
 * a tenth of what an authorization server allows the whole client, so a
 * single address forging its claimed origin cannot use up the client's quota.
 */
export const SIGN_IN_START_CONNECTION_LIMIT = 300;

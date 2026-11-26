/** Deployment settings that are not secret. */

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

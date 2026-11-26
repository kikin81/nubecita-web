import {randomUUID} from "node:crypto";
import {getApps, initializeApp} from "firebase-admin/app";
import {getAppCheck} from "firebase-admin/app-check";
import {onRequest} from "firebase-functions/v2/https";
import {attestationVerifier} from "./attestation";
import {createClientAuthMethodReader} from "./clientMetadata";
import {
  CLIENTS,
  FUNCTION_TIMEOUT_SECONDS,
  REGION,
  RUNTIME_SERVICE_ACCOUNT,
  SIGN_IN_START_LIMIT,
  SIGN_IN_START_WINDOW_MS,
} from "./config";
import {systemLookup} from "./guard";
import {createIssuerResolver} from "./issuer";
import {kmsSigner} from "./kmsSigner";
import {stdoutSink} from "./log";
import {type HandleRequest, createMediator} from "./mediator";
import {guardedSend} from "./outbound";
import {createRateLimit} from "./rateLimit";
import {environmentSettings} from "./settings";

let handler: HandleRequest | undefined;

/** Built on first use, so that loading this module does no work and needs no credentials. */
function mediator(): HandleRequest {
  if (handler !== undefined) return handler;
  const now = Date.now;
  const send = guardedSend(systemLookup);
  handler = createMediator({
    clients: CLIENTS,
    signer: kmsSigner(CLIENTS),
    send,
    resolveIssuer: createIssuerResolver(send, now),
    readClientAuthMethod: createClientAuthMethodReader(send, now),
    verifyAttestation: attestationVerifier(async (token) => {
      if (getApps().length === 0) initializeApp();
      await getAppCheck().verifyToken(token);
    }),
    allowSignInStart: createRateLimit(SIGN_IN_START_LIMIT, SIGN_IN_START_WINDOW_MS, now),
    settings: environmentSettings,
    log: stdoutSink,
    now,
    newId: randomUUID,
  });
  return handler;
}

/**
 * Token-mediating backend for Nubecita's confidential OAuth client.
 *
 * All of the work is I/O, so one vCPU serves many requests at once. (Below one
 * vCPU, 2nd-gen functions are limited to a single concurrent request.)
 */
export const oauthMediator = onRequest(
  {
    region: REGION,
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    cpu: 1,
    memory: "512MiB",
    concurrency: 80,
    minInstances: 0,
    maxInstances: 10,
    timeoutSeconds: FUNCTION_TIMEOUT_SECONDS,
    invoker: "public",
  },
  async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    const response = await mediator()({
      method: req.method,
      path: req.path,
      headers,
      body: req.rawBody?.toString("utf8") ?? "",
      // Best effort, for rate limiting sign-in starts only. Falls back to the
      // connection's address so callers without the header do not all share
      // one bucket.
      callerAddress: headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
    });
    res.status(response.status).set(response.headers).send(response.body);
  },
);

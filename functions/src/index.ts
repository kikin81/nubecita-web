import {onRequest} from "firebase-functions/v2/https";
import {FUNCTION_TIMEOUT_SECONDS, REGION, RUNTIME_SERVICE_ACCOUNT} from "./config";
import {handleRequest} from "./mediator";

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
    const response = await handleRequest({
      method: req.method,
      path: req.path,
      headers,
      body: req.rawBody?.toString("utf8") ?? "",
    });
    res.status(response.status).set(response.headers).send(response.body);
  },
);

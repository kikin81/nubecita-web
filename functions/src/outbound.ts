import {request as httpsRequest} from "node:https";
import type {LookupFunction} from "node:net";
import {type Lookup, type ResolvedAddress, GuardError, assertPublicHostname, checkedAddress} from "./guard";

/** One outbound HTTPS request. */
export interface OutboundRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface OutboundResponse {
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: string;
}

export type Send = (request: OutboundRequest) => Promise<OutboundResponse>;

/** The request provably never reached the server, so nothing it carried was spent. */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

/** The request was sent and no usable answer came back. The server may have acted on it. */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

/** Connects to one specific, already-checked address. */
export type PinnedSend = (request: OutboundRequest, address: ResolvedAddress) => Promise<OutboundResponse>;

/**
 * The only way the backend makes an outbound request: https, default port, a
 * public DNS name, and a connection pinned to an address that was checked.
 * Redirects are never followed; a 3xx comes back to the caller as it is.
 */
export function guardedSend(lookup: Lookup, pinned: PinnedSend = httpsPinned()): Send {
  return async (request) => {
    let address: ResolvedAddress;
    try {
      if (request.url.protocol !== "https:") throw new GuardError("outbound requests must be https");
      if (request.url.port !== "") throw new GuardError("outbound requests must use the default port");
      if (request.url.username !== "" || request.url.password !== "") throw new GuardError("no credentials in URLs");
      assertPublicHostname(request.url.hostname);
      address = await checkedAddress(request.url.hostname, lookup);
    } catch (error) {
      if (error instanceof GuardError) throw error;
      throw new NotSentError("address check failed");
    }
    return pinned(request, address);
  };
}

/** Extra TLS options, for tests that run against a local server. */
export interface PinnedOptions {
  ca?: string | Buffer;
  port?: number;
}

export function httpsPinned(options: PinnedOptions = {}): PinnedSend {
  return (request, address) =>
    new Promise<OutboundResponse>((resolve, reject) => {
      // Node asks for either one address or a list, depending on its
      // connection strategy. Either way it gets the one that was checked.
      const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, [{address: address.address, family: address.family}]);
        } else {
          callback(null, address.address, address.family);
        }
      };

      let connected = false;
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(connected ? new OutcomeUnknownError(message) : new NotSentError(message));
      };

      const req = httpsRequest(
        {
          host: request.url.hostname,
          servername: request.url.hostname,
          port: options.port ?? 443,
          path: `${request.url.pathname}${request.url.search}`,
          method: request.method,
          headers: request.headers,
          lookup: pinnedLookup,
          ca: options.ca,
          // One request per connection: nothing is ever silently re-sent on a
          // recycled socket.
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > request.maxResponseBytes) {
              fail("response too large");
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => fail("response failed"));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
            }
            resolve({status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8")});
          });
        },
      );
      const timer = setTimeout(() => fail("timed out"), request.timeoutMs);
      req.on("socket", (socket) => {
        socket.on("secureConnect", () => {
          connected = true;
        });
      });
      req.on("error", () => fail("request failed"));
      req.end(request.body);
    });
}

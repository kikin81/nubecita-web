import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {type Server, createServer} from "node:https";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {GuardError, type Lookup} from "../src/guard";
import {
  type OutboundRequest,
  type PinnedSend,
  NotSentError,
  OutcomeUnknownError,
  guardedSend,
  httpsPinned,
} from "../src/outbound";

const publicLookup: Lookup = async () => [{address: "93.184.216.34", family: 4}];

function request(url: string, overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {url: new URL(url), method: "POST", headers: {}, body: "a=b", timeoutMs: 2_000, maxResponseBytes: 1024, ...overrides};
}

describe("guardedSend", () => {
  const recordingPinned = (calls: Array<{host: string; address: string}>): PinnedSend => {
    return async (outbound, address) => {
      calls.push({host: outbound.url.hostname, address: address.address});
      return {status: 200, headers: {}, body: "ok"};
    };
  };

  it("connects to the address it checked", async () => {
    const calls: Array<{host: string; address: string}> = [];

    await guardedSend(publicLookup, recordingPinned(calls))(request("https://auth.example/oauth/token"));

    expect(calls).toEqual([{host: "auth.example", address: "93.184.216.34"}]);
  });

  it.each([
    ["plain http", "http://auth.example/token"],
    ["a non-default port", "https://auth.example:8443/token"],
    ["an IP literal", "https://169.254.169.254/computeMetadata/v1/"],
    ["credentials in the URL", "https://user:pass@auth.example/token"],
    ["an internal name", "https://metadata.google.internal/computeMetadata/v1/"],
  ])("refuses %s without connecting", async (_label, url) => {
    const calls: Array<{host: string; address: string}> = [];

    await expect(guardedSend(publicLookup, recordingPinned(calls))(request(url))).rejects.toThrow(GuardError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a host that resolves to a private address, without connecting", async () => {
    const calls: Array<{host: string; address: string}> = [];
    const privateLookup: Lookup = async () => [{address: "10.0.0.8", family: 4}];

    await expect(guardedSend(privateLookup, recordingPinned(calls))(request("https://auth.example/token"))).rejects.toThrow(
      GuardError,
    );
    expect(calls).toHaveLength(0);
  });
});

/**
 * The real sender, against a local TLS server. The URL's hostname does not
 * resolve anywhere: a request can only succeed if the sender connects to the
 * address it is handed and still validates the certificate against the name.
 */
describe("httpsPinned", () => {
  let directory: string;
  let ca: Buffer;
  let server: Server;
  let port: number;
  const seen: Array<{method: string; url: string; dpop: string | undefined; body: string}> = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "mediator-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-keyout", join(directory, "key.pem"),
        "-out", join(directory, "cert.pem"),
        "-subj", "/CN=auth.test",
        "-addext", "subjectAltName=DNS:auth.test",
      ],
      {stdio: "ignore"},
    );
    ca = readFileSync(join(directory, "cert.pem"));
    server = createServer({key: readFileSync(join(directory, "key.pem")), cert: ca}, (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        seen.push({method: req.method ?? "", url: req.url ?? "", dpop: req.headers["dpop"] as string | undefined, body});
        switch (req.url) {
          case "/hang":
            return; // never answers
          case "/reset":
            req.socket.destroy();
            return;
          case "/large":
            res.writeHead(200).end("x".repeat(5_000));
            return;
          case "/redirect":
            res.writeHead(302, {location: "/followed"}).end();
            return;
          default:
            res.writeHead(400, {"content-type": "application/json", "dpop-nonce": "nonce-1"});
            res.end('{"error":"use_dpop_nonce"}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, {recursive: true, force: true});
  });

  const loopback = {address: "127.0.0.1", family: 4} as const;
  const send = (path: string, overrides: Partial<OutboundRequest> = {}, host = "auth.test") =>
    httpsPinned({ca, port})(request(`https://${host}${path}`, overrides), loopback);

  it("connects to the pinned address, sends the request as given, and returns the answer as it is", async () => {
    const response = await send("/oauth/token?x=1", {headers: {dpop: "proof.jwt.sig", "content-type": "application/x-www-form-urlencoded"}});

    expect(response.status).toBe(400);
    expect(response.body).toBe('{"error":"use_dpop_nonce"}');
    expect(response.headers["dpop-nonce"]).toBe("nonce-1");
    expect(seen.at(-1)).toEqual({method: "POST", url: "/oauth/token?x=1", dpop: "proof.jwt.sig", body: "a=b"});
  });

  it("still checks the certificate against the hostname, not the address", async () => {
    await expect(send("/oauth/token", {}, "other.test")).rejects.toThrow(NotSentError);
  });

  it("does not follow a redirect", async () => {
    const before = seen.length;

    const response = await send("/redirect");

    expect(response.status).toBe(302);
    expect(seen.slice(before).map((entry) => entry.url)).toEqual(["/redirect"]);
  });

  it("reports 'not sent' when nothing is listening", async () => {
    const closedPort = port === 65535 ? port - 1 : port + 1;

    await expect(httpsPinned({ca, port: closedPort})(request("https://auth.test/x"), loopback)).rejects.toThrow(NotSentError);
  });

  it("reports an unknown outcome when the server never answers", async () => {
    await expect(send("/hang", {timeoutMs: 300})).rejects.toThrow(OutcomeUnknownError);
  });

  it("reports an unknown outcome when the connection drops after the request was sent", async () => {
    await expect(send("/reset")).rejects.toThrow(OutcomeUnknownError);
  });

  it("refuses a response larger than the cap", async () => {
    await expect(send("/large", {maxResponseBytes: 1_000})).rejects.toThrow(OutcomeUnknownError);
  });
});

#!/usr/bin/env node
// Sends a real pushed authorization request for a Nubecita OAuth client through
// the token-mediating backend, the way the app does: a DPoP proof made for the
// authorization server's own endpoint, the issuer in a header, and one retry
// when the server asks for a nonce. A PAR spends nothing and creates no
// session; the request it registers expires unused after five minutes.
//
// Usage: node infra/smoke-par.mjs <backend-base-url> <client-id> [issuer]
//   node infra/smoke-par.mjs https://auth.nubecita.app https://nubecita.app/oauth/client-metadata-test.json
import {createHash, generateKeyPairSync, randomBytes, randomUUID, sign} from "node:crypto";

const [backend, clientId, issuer = "https://bsky.social"] = process.argv.slice(2);
if (!backend || !clientId) {
  console.error("usage: node infra/smoke-par.mjs <backend-base-url> <client-id> [issuer]");
  process.exit(2);
}

const metadata = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
const parEndpoint = metadata.pushed_authorization_request_endpoint;

const {privateKey, publicKey} = generateKeyPairSync("ec", {namedCurve: "P-256"});
const {kty, crv, x, y} = publicKey.export({format: "jwk"});
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function dpopProof(nonce) {
  const header = b64({typ: "dpop+jwt", alg: "ES256", jwk: {kty, crv, x, y}});
  const payload = b64({jti: randomUUID(), htm: "POST", htu: parEndpoint, iat: Math.floor(Date.now() / 1000), ...(nonce ? {nonce} : {})});
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {key: privateKey, dsaEncoding: "ieee-p1363"});
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const verifier = randomBytes(32).toString("base64url");
const form = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: "https://nubecita.app/oauth-redirect/",
  scope: "atproto transition:generic transition:chat.bsky",
  state: randomBytes(16).toString("base64url"),
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
});

async function attempt(nonce) {
  const started = performance.now();
  const response = await fetch(`${backend}/par`, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded", DPoP: dpopProof(nonce), "Nubecita-Issuer": issuer},
    body: form,
  });
  const body = await response.text();
  const headers = Object.fromEntries(
    ["nubecita-mediator-origin", "nubecita-client-auth-kid", "nubecita-client-auth-method", "nubecita-upstream-date", "dpop-nonce"]
      .map((name) => [name, response.headers.get(name)])
      .filter(([, value]) => value !== null),
  );
  return {status: response.status, ms: Math.round(performance.now() - started), headers, body};
}

let result = await attempt();
const print = (label, r) =>
  console.log(label, JSON.stringify({status: r.status, ms: r.ms, ...r.headers, body: r.body.replace(/(request_uri":"urn:ietf:params:oauth:request_uri:)[^"]+/, "$1<redacted>")}));
print("attempt 1:", result);
if (result.headers["dpop-nonce"] && result.status !== 201 && result.status !== 200) {
  result = await attempt(result.headers["dpop-nonce"]);
  print("attempt 2:", result);
}
const ok = (result.status === 201 || result.status === 200) && result.headers["nubecita-mediator-origin"] === "upstream" && /request_uri/.test(result.body);
console.log(ok ? "RESULT: the authorization server accepted the pushed request" : "RESULT: not accepted");
process.exit(ok ? 0 : 1);

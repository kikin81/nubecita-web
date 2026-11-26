import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {validateClientMetadata} from "./validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const load = (file) => JSON.parse(readFileSync(join(here, file), "utf8"));
const urlOf = (file) => `https://nubecita.app/oauth/${file}`;

const KEY = {kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43), kid: "test-1", alg: "ES256", use: "sig"};
const ID = "https://nubecita.app/oauth/client-metadata-test.json";
const confidential = (overrides = {}) => ({
  client_id: ID,
  application_type: "web",
  client_name: "Nubecita (test)",
  client_uri: "https://nubecita.app",
  dpop_bound_access_tokens: true,
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: ["https://nubecita.app/oauth-redirect/"],
  response_types: ["code"],
  scope: "atproto transition:generic",
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_signing_alg: "ES256",
  jwks: {keys: [KEY]},
  ...overrides,
});
const publicClient = (overrides = {}) => {
  const {jwks: _jwks, token_endpoint_auth_signing_alg: _alg, ...rest} = confidential();
  return {
    ...rest,
    application_type: "native",
    token_endpoint_auth_method: "none",
    redirect_uris: ["app.nubecita:/oauth-redirect", "https://nubecita.app/oauth-redirect/"],
    ...overrides,
  };
};
const errors = (metadata, id = ID) => validateClientMetadata(metadata, id);
const rejects = (metadata, pattern, id = ID) => {
  const found = errors(metadata, id);
  assert.ok(found.some((message) => pattern.test(message)), `expected an error matching ${pattern}, got: ${JSON.stringify(found)}`);
};

test("every published metadata file is valid", () => {
  const files = readdirSync(here).filter((file) => /^client-metadata.*\.json$/.test(file));
  assert.ok(files.includes("client-metadata.json"));
  for (const file of files) {
    assert.deepEqual(validateClientMetadata(load(file), urlOf(file)), [], file);
  }
});

test("test and production clients advertise different keys", () => {
  const kids = (file) => (load(file).jwks?.keys ?? []).map((key) => `${key.x}.${key.y}`);
  const test_ = kids("client-metadata-test.json");
  assert.equal(test_.length, 1);
  for (const key of kids("client-metadata.json")) assert.ok(!test_.includes(key));
});

test("a well-formed confidential client and a well-formed public client pass", () => {
  assert.deepEqual(errors(confidential()), []);
  assert.deepEqual(errors(publicClient()), []);
});

test("a native client cannot authenticate with a key", () => {
  rejects(confidential({application_type: "native"}), /native.*none/i);
});

test("a confidential client must be a web client with only https redirects", () => {
  rejects(confidential({redirect_uris: ["app.nubecita:/oauth-redirect"]}), /https/i);
  rejects(confidential({redirect_uris: ["http://nubecita.app/oauth-redirect"]}), /https/i);
  rejects(confidential({redirect_uris: ["https://localhost/oauth-redirect"]}), /local/i);
  rejects(confidential({redirect_uris: ["http://127.0.0.1/cb"]}), /https/i);
});

test("a confidential client must embed its keys and name its algorithm", () => {
  const {jwks: _jwks, ...withoutKeys} = confidential();
  rejects(withoutKeys, /jwks/);
  rejects(confidential({jwks: {keys: []}}), /at least one key/);
  rejects({...withoutKeys, jwks_uri: "https://nubecita.app/oauth/jwks.json"}, /embedded/);
  const {token_endpoint_auth_signing_alg: _alg, ...withoutAlg} = confidential();
  rejects(withoutAlg, /token_endpoint_auth_signing_alg/);
  rejects(confidential({token_endpoint_auth_signing_alg: "RS256"}), /ES256/);
});

test("published keys must be public P-256 signing keys with unique ids", () => {
  rejects(confidential({jwks: {keys: [{...KEY, d: "private"}]}}), /private/);
  rejects(confidential({jwks: {keys: [{...KEY, crv: "P-384"}]}}), /P-256/);
  rejects(confidential({jwks: {keys: [{...KEY, kty: "RSA"}]}}), /P-256/);
  rejects(confidential({jwks: {keys: [{...KEY, kid: ""}]}}), /kid/);
  rejects(confidential({jwks: {keys: [KEY, {...KEY}]}}), /duplicate/i);
  rejects(confidential({jwks: {keys: [{...KEY, alg: "RS256"}]}}), /ES256/);
  rejects(confidential({jwks: {keys: [{...KEY, use: "enc"}]}}), /sig/);
});

test("a public client carries no key material", () => {
  rejects(publicClient({token_endpoint_auth_signing_alg: "ES256"}), /must not/);
  rejects(publicClient({jwks: {keys: [KEY]}}), /must not/);
});

test("a native client's custom scheme must be the reversed client_id host", () => {
  rejects(publicClient({redirect_uris: ["com.example.app:/oauth-redirect"]}), /app\.nubecita/);
  rejects(publicClient({redirect_uris: ["nubecita:/oauth-redirect"]}), /app\.nubecita/);
});

test("the client_id must be the URL the file is served from", () => {
  rejects(confidential(), /client_id/, "https://nubecita.app/oauth/client-metadata.json");
  rejects(confidential({client_id: undefined}), /client_id/);
});

test("the fields every AT Protocol client needs are present and right", () => {
  rejects(confidential({dpop_bound_access_tokens: false}), /dpop_bound_access_tokens/);
  rejects(confidential({grant_types: ["authorization_code"]}), /refresh_token/);
  rejects(confidential({response_types: ["token"]}), /response_types/);
  rejects(confidential({scope: "transition:generic"}), /atproto/);
  rejects(confidential({redirect_uris: []}), /redirect_uri/);
  rejects(confidential({client_uri: "https://example.com"}), /client_uri/);
  rejects(confidential({application_type: "desktop"}), /application_type/);
  rejects(confidential({token_endpoint_auth_method: "client_secret_post"}), /token_endpoint_auth_method/);
  rejects(confidential({redirect_uris: ["https://user:pass@nubecita.app/cb"]}), /credentials/);
});

test("nonsense input is reported, not thrown", () => {
  assert.ok(errors(null).length > 0);
  assert.ok(errors([]).length > 0);
  assert.ok(errors("{}").length > 0);
});

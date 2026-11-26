#!/usr/bin/env node
/**
 * Checks the OAuth client metadata files in this directory against the rules
 * an AT Protocol authorization server applies when it loads them, plus the
 * rules this project adds on top (keys embedded, never linked).
 *
 * A file that fails here would be rejected by authorization servers, which
 * means nobody could sign in with that client. Run: node oauth/validate.mjs
 */
import {readFileSync, readdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const AUTH_METHODS = ["none", "private_key_jwt"];
const APPLICATION_TYPES = ["web", "native"];
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/**
 * @param {unknown} metadata parsed JSON
 * @param {string} expectedClientId the URL the file is served from
 * @returns {string[]} problems found; empty when the file is valid
 */
export function validateClientMetadata(metadata, expectedClientId) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["metadata must be a JSON object"];
  }
  const problems = [];
  const fail = (message) => problems.push(message);

  if (metadata.client_id !== expectedClientId) {
    fail(`client_id must be the URL the file is served from (${expectedClientId})`);
  }
  const clientUrl = new URL(expectedClientId);

  if (!APPLICATION_TYPES.includes(metadata.application_type)) fail("application_type must be web or native");
  const method = metadata.token_endpoint_auth_method;
  if (!AUTH_METHODS.includes(method)) fail("token_endpoint_auth_method must be none or private_key_jwt");
  const native = metadata.application_type === "native";

  // A native app cannot keep a key, so servers refuse a native client that claims one.
  if (native && method !== "none") fail('native clients must use token_endpoint_auth_method "none"');

  if (metadata.dpop_bound_access_tokens !== true) fail("dpop_bound_access_tokens must be true");
  const grants = Array.isArray(metadata.grant_types) ? metadata.grant_types : [];
  for (const grant of ["authorization_code", "refresh_token"]) {
    if (!grants.includes(grant)) fail(`grant_types must include ${grant}`);
  }
  if (!Array.isArray(metadata.response_types) || metadata.response_types.length !== 1 || metadata.response_types[0] !== "code") {
    fail('response_types must be ["code"]');
  }
  if (typeof metadata.scope !== "string" || !metadata.scope.split(" ").includes("atproto")) {
    fail('scope must include "atproto"');
  }

  if (metadata.client_uri !== undefined) {
    let clientUri;
    try {
      clientUri = new URL(metadata.client_uri);
    } catch {
      fail("client_uri must be a URL");
    }
    if (clientUri !== undefined) {
      const parent = clientUri.pathname.endsWith("/") ? clientUri.pathname : `${clientUri.pathname}/`;
      if (clientUri.origin !== clientUrl.origin || !clientUrl.pathname.startsWith(parent)) {
        fail("client_uri must be a parent URL of the client_id");
      }
    }
  }

  const redirects = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (redirects.length === 0) fail("at least one redirect_uri is required");
  const privateScheme = `${clientUrl.hostname.split(".").reverse().join(".")}:`;
  for (const redirect of redirects) {
    let url;
    try {
      url = new URL(redirect);
    } catch {
      fail(`redirect_uri ${redirect} is not a URL`);
      continue;
    }
    if (url.username !== "" || url.password !== "") fail(`redirect_uri ${redirect} must not contain credentials`);
    if (url.protocol === "https:") {
      if (url.hostname === "localhost" || url.hostname.endsWith(".local")) fail(`redirect_uri ${redirect} must not be a local hostname`);
    } else if (url.protocol.includes(".")) {
      // A private-use scheme such as app.nubecita:/...
      if (!native) fail(`redirect_uri ${redirect}: a web client may only use https redirects`);
      else if (url.protocol !== privateScheme) fail(`redirect_uri ${redirect}: the scheme must be ${privateScheme}`);
    } else {
      fail(`redirect_uri ${redirect}: only https${native ? ` or ${privateScheme}` : ""} redirects are allowed`);
    }
  }

  if (method === "none") {
    if (metadata.token_endpoint_auth_signing_alg !== undefined) fail('a "none" client must not declare token_endpoint_auth_signing_alg');
    if (metadata.jwks !== undefined || metadata.jwks_uri !== undefined) fail('a "none" client must not publish keys');
  }

  if (method === "private_key_jwt") {
    if (metadata.token_endpoint_auth_signing_alg === undefined) fail("token_endpoint_auth_signing_alg is required");
    else if (metadata.token_endpoint_auth_signing_alg !== "ES256") fail("token_endpoint_auth_signing_alg must be ES256");
    // Linked keys would let the method and the keys change at different
    // times, and servers cache the two separately.
    if (metadata.jwks_uri !== undefined) fail("keys must be embedded in jwks, not linked with jwks_uri");
    const keys = metadata.jwks?.keys;
    if (!Array.isArray(keys)) {
      fail("private_key_jwt requires an embedded jwks");
    } else {
      if (keys.length === 0) fail("jwks must contain at least one key");
      const seen = new Set();
      for (const key of keys) {
        const label = typeof key?.kid === "string" && key.kid !== "" ? key.kid : "(no kid)";
        if (key === null || typeof key !== "object") {
          fail("jwks contains a value that is not a key");
          continue;
        }
        if (PRIVATE_JWK_FIELDS.some((field) => field in key)) fail(`key ${label} contains private key material`);
        if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") {
          fail(`key ${label} must be an EC P-256 public key`);
        }
        if (typeof key.kid !== "string" || key.kid === "") fail("every key needs a kid");
        else if (seen.has(key.kid)) fail(`duplicate kid ${key.kid}`);
        else seen.add(key.kid);
        if (key.alg !== "ES256") fail(`key ${label} must declare alg ES256`);
        if (key.use !== "sig") fail(`key ${label} must declare use sig`);
      }
    }
  }

  return problems;
}

function main() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(directory).filter((file) => /^client-metadata.*\.json$/.test(file)).sort();
  let failed = false;
  for (const file of files) {
    let problems;
    try {
      problems = validateClientMetadata(
        JSON.parse(readFileSync(join(directory, file), "utf8")),
        `https://nubecita.app/oauth/${file}`,
      );
    } catch (error) {
      problems = [`not valid JSON: ${error.message}`];
    }
    if (problems.length === 0) {
      console.log(`ok    oauth/${file}`);
    } else {
      failed = true;
      console.log(`FAIL  oauth/${file}`);
      for (const problem of problems) console.log(`      - ${problem}`);
    }
  }
  if (files.length === 0) {
    console.log("FAIL  no client metadata files found");
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();

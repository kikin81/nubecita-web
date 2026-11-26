# nubecita.app

The marketing site, privacy policy, terms of service, and AT Protocol OAuth
client manifest for [Nubecita](https://github.com/kikin81/nubecita) — a calm,
native Android client for the [Bluesky](https://bsky.app) social network, built
on the [AT Protocol](https://atproto.com).

Deployed at <https://nubecita.app>, served from the `main` branch of this
repository via GitHub Pages.

## Structure

```text
.
├── index.html                    Landing page
├── privacy-policy/index.html     Privacy policy (linked from Google Play Console)
├── terms/index.html              Terms of service
├── oauth/client-metadata.json    AT Protocol OAuth client manifest
├── oauth/client-metadata-*.json  Test and rehearsal clients (never used by production builds)
├── oauth/validate.mjs            Checks every client manifest against authorization-server rules
├── functions/                    OAuth token-mediating backend (Firebase Functions)
├── infra/                        Provisioning scripts for the backend
├── firebase.json                 Function + Hosting rewrite (auth.nubecita.app) + Firestore rules
├── firestore.rules               Deny-all rules for the backend's replay database
├── assets/                       Logos, OG image, illustrations
└── .github/workflows/ci.yml      Link check + HTML validation + pre-commit
```

## Local development

There is no build step — files are served as-is by GitHub Pages. To preview
locally, run any static file server from the repo root:

```sh
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>.

## OAuth backend

`functions/` is a small Firebase function, reached at
<https://auth.nubecita.app>, that lets the Nubecita app act as a
*confidential* AT Protocol OAuth client. The app sends it the four OAuth
requests that need client authentication (pushed authorization request, code
exchange, refresh, revocation); it adds a signed client assertion and relays
the request to the user's authorization server. It never sees a device's DPoP
key, so it cannot use any token it handles. All other traffic goes straight
from the app to the PDS.

The client signing keys live in Cloud KMS and cannot be exported. This
repository holds only public keys and key ids. Design and rationale:
[`openspec/changes/add-confidential-oauth-client`](https://github.com/kikin81/nubecita/tree/main/openspec/changes/add-confidential-oauth-client)
in the app repository.

```sh
cd functions
npm ci
npm test               # unit tests
npm run test:emulator  # the replay store against the Firestore emulator
npm run lint
npm run serve          # local emulator on http://127.0.0.1:5001
```

The emulator tests run over gRPC by default, which needs no Google credentials (CI has none). The deployed function uses REST; to run the same tests that way, on a machine signed in with `gcloud auth application-default login`:

```sh
EMULATOR_PREFER_REST=true npm run test:emulator
```

`npm run test:emulator` needs the Firebase CLI (`npm install --global
firebase-tools@15`) and a JDK 21 or newer on the `PATH`. It starts the
Firestore emulator under a `demo-` project id, so it never touches a real
project.

- `infra/provision.sh` creates the keys, service accounts, federation, the
  replay database (with its security rules, TTL policy and access grant) and
  the alerts. It is idempotent; `--dry-run` prints what it would do.
- `infra/export-jwk.sh <key> <version> <kid>` prints a key's public JWK for a
  client metadata file.
- `infra/smoke-par.mjs <backend-url> <client-id>` sends a real sign-in start
  through the backend, the way the app does. It spends nothing and creates no
  session. Use the test client, never the production one.
- Deploys run from `main` only, through the `Deploy backend` workflow, and wait
  for approval in the `production` environment.

The backend mediates exactly three paths, all `POST`: `/par`, `/token`
(authorization-code and refresh grants) and `/revoke`. Every response carries
`Nubecita-Mediator-Origin`: `upstream` when it is the authorization server's own
answer relayed unchanged, `mediator` when the backend produced it. A
backend-produced error is `{"error": "mediator_<reason>", "forwarded": false |
true | "unknown"}` and is never an OAuth error.

These settings can be changed on the running service without a deploy, by
updating its environment (`gcloud run services update oauthmediator --region
us-central1 --update-env-vars NAME=value`); the next deploy resets them:

| Variable | Effect |
| --- | --- |
| `MEDIATOR_BYPASS` | `true`: answer every request "not forwarded, use the direct path" and contact no authorization server. The one exception is a refresh the replay store holds an answer for, which still gets that answer. Only useful while the production client is still public. |
| `MEDIATOR_ENFORCE_SIGN_IN_ATTESTATION` | `true`: refuse sign-ins without a valid App Check token. Off means observe only. |
| `MEDIATOR_STRICT_REFRESH_ATTESTATION` | `true`: also refuse refreshes and sign-outs without one. Leave off: an attestation outage would otherwise stall signed-in users. |
| `MEDIATOR_MIN_REFRESH_INTERVAL_MINUTES` | A number of minutes, up to 1440. Refuse (`mediator_rate_limited`, not forwarded) a refresh whose refresh token the backend handed out less than that long ago. Unset or `0` is off. See "The flip guard" below. |

### Replay-safe refresh

AT Protocol refresh tokens are single-use, and an authorization server deletes
the whole session when a spent one is presented again. A refresh response lost
between the backend and the phone would therefore sign the user out: the phone
can only retry with the token it still has. So the backend remembers each
successful refresh response for 24 hours and gives it again to the same device.

- **One forward at a time.** Before forwarding a refresh the backend claims its
  refresh token. A second request with the same token inside 60 seconds is
  answered `mediator_in_progress` with `forwarded: "unknown"` instead of being
  forwarded. If the authorization server does not answer in time the claim is
  kept, so retries wait; on any answer that is not a success (a DPoP nonce
  challenge, for one) it is given back at once.
- **A lost answer is given again.** A request that presents a refresh token
  the backend has an answer for gets that answer, marked `Nubecita-Replayed: 1`,
  without the authorization server being contacted. It must carry a DPoP proof
  that is valid, at most five minutes old, made for the token endpoint, and
  signed by the same key as the original refresh. Anyone else is refused
  (`mediator_bad_request`); the spent token is never forwarded.
- **Nothing readable is stored.** Entries live in a Firestore database of their
  own (`oauth-replay`, collection `refreshReplay`). An entry is named by a hash
  of the refresh token and its content is encrypted (AES-256-GCM) under a key
  derived from that same token, which the backend does not keep. The database
  on its own yields no token. `firestore.rules` refuses every client; only the
  function's service account can reach it.
- **Entries go away.** An entry is deleted as soon as the refresh token it
  handed out is used (the device evidently received it), and otherwise stops
  being served after 24 hours. A Firestore TTL policy removes what is left.

The log line for a request has `replayed: true` when the answer came from the
store, and `replayStore: "unavailable"` or `"write_failed"` when the store let
a refresh down. Both of those feed the `OAuth backend: replay store failures`
alert.

**The database must exist before this code is deployed.** If the backend cannot
consult the store it does not forward a refresh, because the token may already
be spent. It answers `mediator_bypass` ("not forwarded, use the direct path")
and logs `replayStore: "unavailable"`. The app goes direct only with a refresh
token whose earlier attempts all provably went nowhere, and keeps retrying the
backend with one that may be spent. So while the client is public a store
outage delays only the retries it could have hurt; once the client is
confidential the direct path cannot refresh and every refresh waits for the
store. Run `infra/provision.sh` first, then check that a client is refused:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://firestore.googleapis.com/v1/projects/nubecita-2a4c1/databases/oauth-replay/documents/refreshReplay'
# 403
```

`firestore.rules` is deployed by `infra/provision.sh`, not by the deploy
workflow: run the script again after changing it.

#### The flip guard

Changing the production client from public to confidential is seen by each
authorization-server process up to ten minutes apart. A session refreshed twice
inside that window can land first on a process that already treats the client
as confidential and then on one that does not, which deletes the session. For
the hour around the change, set `MEDIATOR_MIN_REFRESH_INTERVAL_MINUTES` above
the combined cache window (30 is a safe choice) and unset it afterwards. The
app still holds a fresh access token when it is refused, so the refusal costs
nothing.

- A value that is not a number between 0 and 1440 makes **every** request fail
  with `mediator_internal` until it is corrected. That is deliberate: a
  mistyped guard that silently stayed off would not be noticed until sessions
  were lost. After setting it, check that requests still succeed.
- The guard knows when a refresh token was handed out from the replay store.
  It therefore does not cover a refresh token that came from a sign-in rather
  than from a refresh, or one whose answer could not be recorded.

GitHub Pages serves this repository's root, so these source files are also
reachable under `nubecita.app`. That is harmless: the repository is public and
contains no secrets.

## Contributing

### One-time setup

```sh
pre-commit install
pre-commit install --hook-type commit-msg
```

This installs the same hooks CI runs:

- **[`pre-commit-hooks`](https://github.com/pre-commit/pre-commit-hooks)** — JSON/YAML,
  merge-conflict, large-file, end-of-file, trailing-whitespace, line-ending
- **[`commitlint`](https://commitlint.js.org/)** — enforces
  [Conventional Commit](https://www.conventionalcommits.org/) prefixes
  (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, …) on commit messages
- **[`actionlint`](https://github.com/rhysd/actionlint)** — lints GitHub Actions
  workflow files
- **[`gitleaks`](https://github.com/gitleaks/gitleaks)** — scans for
  accidentally committed secrets

### CI

Every PR runs three jobs (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

- **Link check** ([`lychee`](https://lychee.cli.rs/)) — catches broken links in
  all HTML files. Self-references to `nubecita.app` are excluded so pre-deploy
  canonical URLs don't trip the check.
- **HTML validation** ([`html5validator`](https://github.com/svenkreiss/html5validator)) —
  catches malformed markup. Inline-CSS errors are ignored (vnu's CSS rules
  flag modern properties like `font-variation-settings` as unknown).
- **pre-commit** — runs the hooks listed above.

### Running CI checks locally

```sh
# Link check
lychee --no-progress --accept 200,206,429 --max-retries 2 \
  --root-dir "$(pwd)" --exclude 'https?://nubecita\.app' './**/*.html'

# HTML validation
html5validator --root . --ignore "CSS:"

# All pre-commit hooks
pre-commit run --all-files
```

### Regenerating the OpenGraph card

The OG image source is [`assets/og-image.svg`](assets/og-image.svg). To
rebuild the PNG after edits:

```sh
brew install librsvg  # one-time, for rsvg-convert
rsvg-convert -w 1200 -h 630 assets/og-image.svg -o assets/og-image.png
```

The PNG and SVG should be committed together so the source stays in lockstep
with the rendered card.

## Related

- **Android app** — [`kikin81/nubecita`](https://github.com/kikin81/nubecita)
- **Bluesky on AT Protocol** — <https://atproto.com>

## License

See [`kikin81/nubecita`](https://github.com/kikin81/nubecita) for the license
that applies to the Nubecita project. This repository is published under the
same terms.

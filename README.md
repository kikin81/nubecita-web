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
├── firebase.json                 Function + Hosting rewrite (auth.nubecita.app)
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
npm test          # unit tests
npm run lint
npm run serve     # local emulator on http://127.0.0.1:5001
```

- `infra/provision.sh` creates the keys, service accounts, federation and
  budget alert. It is idempotent; `--dry-run` prints what it would do.
- `infra/export-jwk.sh <key> <version> <kid>` prints a key's public JWK for a
  client metadata file.
- Deploys run from `main` only, through the `Deploy backend` workflow, and wait
  for approval in the `production` environment.

The backend mediates exactly three paths, all `POST`: `/par`, `/token`
(authorization-code and refresh grants) and `/revoke`. Every response carries
`Nubecita-Mediator-Origin`: `upstream` when it is the authorization server's own
answer relayed unchanged, `mediator` when the backend produced it. A
backend-produced error is `{"error": "mediator_<reason>", "forwarded": false |
true | "unknown"}` and is never an OAuth error.

Three switches can be flipped on the running service without a deploy, by
updating its environment (`gcloud run services update oauthmediator --region
us-central1 --update-env-vars NAME=true`); the next deploy resets them:

| Variable | Effect |
| --- | --- |
| `MEDIATOR_BYPASS` | Answer every request "not forwarded, use the direct path" and contact no authorization server. Only useful while the production client is still public. |
| `MEDIATOR_ENFORCE_SIGN_IN_ATTESTATION` | Refuse sign-ins without a valid App Check token. Off means observe only. |
| `MEDIATOR_STRICT_REFRESH_ATTESTATION` | Also refuse refreshes and sign-outs without one. Leave off: an attestation outage would otherwise stall signed-in users. |

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

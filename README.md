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

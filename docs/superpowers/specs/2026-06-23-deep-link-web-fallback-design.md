# Deep-link web fallback — design

**Repo:** `nubecita-web` (static GitHub Pages site serving `nubecita.app`). **Branch:**
`feat/deep-link-web-fallback`.

## Purpose

When a Nubecita deep link is opened in a **browser** rather than handed off to the native Android app,
`nubecita.app` currently returns the generic GitHub Pages 404 — a dead end. This happens when the
recipient has no app, an app version older than the one declaring the path, or taps the link inside a
chat app's in-app webview (WhatsApp / Instagram / Telegram bypass Android App Links). Replace that
dead end with a friendly "open in the Nubecita app / get the app" landing.

The links affected (all `https://nubecita.app/...`):

- `/group/join/{code}` — group invite (the immediate trigger; shipped app-side in v1.239.0).
- `/profile/{handle}` — profile.
- `/profile/{handle}/post/{rkey}` — post.

## Scope

Enhance the existing `404.html` only. No new routes, no server, no build step, no `assetlinks.json`
change (the domain is already verified; `404.html` is served by GitHub Pages for every unmatched
path). Out of scope: fetching live group/profile/post details (generic copy only); returning HTTP 200
(GitHub Pages can't — see Limitations). Non-Android visitors are handed off to **Bluesky web**
(`bsky.app`) for profile/post links (1:1 URL mapping) and to the Play Store for group invites
(no web equivalent) — see the platform × variant matrix.

## Approach

GitHub Pages serves `404.html` (with HTTP 404 status) for any path that doesn't map to a real file, and
client JS can read `location.pathname`. So `404.html` becomes a tiny client-side router:

1. The current generic-404 markup stays as the **default** in the document body — no-JS clients and
   unmatched paths see exactly today's page (progressive enhancement; nothing regresses).
2. An inline `<script>` runs on load, classifies `location.pathname`, and — only on a match — hides
   the generic block and reveals an invite-landing block with variant-specific copy + open buttons.

All logic is **inline in `404.html`** because it is the catch-all and must be self-contained (a
separate JS file at a path would itself 404 reliably only from the same origin, but inlining avoids an
extra request and keeps the fallback bulletproof).

## Components

### `classifyPath(pathname): "group" | "profile" | "post" | null` (pure)

Strict allowlist regexes (order matters — post before profile):

- group: `^/group/join/[A-Za-z0-9._-]+/?$`
- post: `^/profile/[^/]+/post/[^/]+/?$`
- profile: `^/profile/[^/]+/?$`

Anything else → `null` → leave the generic 404 untouched. Keeping this a small pure function makes it
the one piece worth reasoning about carefully (and unit-testable if a harness is ever added).

Input is always `location.pathname` — **not** `location.href`. The query string and hash are dropped
by design: the app routes on path, so tracking params (`/profile/alice/post/3k?ref=whatsapp`) are
irrelevant and must not pollute the intent data URI. AT-Protocol DIDs are supported because `[^/]+`
matches the colons in `did:plc:…` (e.g. `/profile/did:plc:abc/post/3k` classifies as `post`).

### Open-URL builder (Android)

For a classified path, build the intent-scheme open-or-fallback URL from the **validated** `pathname`:

```
intent://nubecita.app{pathname}#Intent;scheme=https;package=net.kikin.nubecita;S.browser_fallback_url={ENCODED_PLAY_URL};end
```

- `ENCODED_PLAY_URL` = `encodeURIComponent("https://play.google.com/store/apps/details?id=net.kikin.nubecita")`.
- If the app (v1.239.0+, which declares these paths) is installed, Android opens it with the `https`
  VIEW intent → `MainActivity.handleIntent` → the existing matchers route it. If not installed, Chrome
  follows `browser_fallback_url` to the Play Store.
- The intent button is a **user-gesture** retry — more likely to escape an in-app webview than the
  original auto App-Link attempt that already failed.

### The landing markup + behavior

- Reuses the existing cloud SVG mark and `colors_and_type.css` / `styles.css` theme tokens (light/dark
  already handled). A new `.invite` style block mirrors `.not-found` spacing.
- Headline + subline by variant:
  - group → "You're invited to a group" / "Open this invite in the Nubecita app."
  - profile → "View this profile on Nubecita" / "Open it in the Nubecita app."
  - post → "View this post on Nubecita" / "Open it in the Nubecita app."

#### Primary action by platform × variant

Android detection: `/android/i.test(navigator.userAgent)`.

| | **group** | **profile** / **post** |
|---|---|---|
| **Android** | "Open in Nubecita" → intent URL; secondary "Get it on Google Play" | "Open in Nubecita" → intent URL; secondary "Get it on Google Play" |
| **Non-Android** (iOS/desktop) | "Get it on Google Play" + note "Nubecita is an Android app." | **"View on Bluesky Web"** → `https://bsky.app{pathname}`; secondary "Get the Nubecita Android app" |

Rationale for the Bluesky handoff: Nubecita is an AT-Protocol client whose `/profile/{handle}` and
`/profile/{handle}/post/{rkey}` URLs map **1:1** to `bsky.app`, so a non-Android visitor to a profile
or post link gets an instant, useful destination instead of a dead "Android-only" message. **Group
invites have no `bsky.app` web equivalent** (group chat is app-only), so non-Android group invites keep
the Play Store as the only action. The `bsky.app` URL is built from the validated `pathname` and
assigned via the anchor's `href` property (never `innerHTML`).

#### In-app webview escape hatch

Some in-app webviews (Instagram, Facebook, Line) silently swallow `intent://` — tapping "Open in
Nubecita" does nothing. On click of that button, start a `1500ms` timer; if it fires while
`document.hidden === false` (i.e. we did NOT background into the app), reveal a helper line beneath the
button: *"Nothing happening? Tap the ⋮ menu and choose 'Open in browser' (Chrome)."* Static copy, hidden
by default, shown only on the stuck path.

#### Analytics (GA4 404 trap)

Because GitHub Pages serves this with a 404 status, GA4 auto-logs a `page_view` titled "Not found —
Nubecita", which would bury the custom metric. On a successful classification, set `document.title` to a
variant title (e.g. `"Nubecita — Group invite"`) **before** firing
`gtag('event', 'deep_link_fallback', { link_type: <variant>, platform: <android|other>, page_title: document.title })`
so the custom event carries a meaningful title and isn't lumped under generic 404 reports.

## Security

- The pathname is **never** inserted into the DOM (no `innerHTML`/`textContent` of `location.pathname`)
  — all displayed copy is static per-variant. This blocks reflected-XSS via a crafted path
  (`/group/join/<script>` fails the regex anyway and falls through to the generic 404).
- The intent URL is built from the pathname **only after** it passes the strict `classifyPath` regex,
  and the path is inserted into the `intent://` string verbatim (already constrained to safe chars by
  the regex), with the Play Store fallback URL `encodeURIComponent`-encoded. No open-redirect: the
  `package=` pins the target app and the host is hard-coded `nubecita.app`.
- The Bluesky-web handoff href is `"https://bsky.app" + pathname` (host hard-coded), set via the
  anchor's `href` **property** (not `innerHTML`), and only for paths already validated as `profile`/`post`
  by `classifyPath` — so it can't be steered to another origin.

## Error handling / edge cases

- No JS / JS error → generic 404 remains (default markup). 
- Path matches a deep-link *prefix* but is malformed (e.g. `/group/join/` with no code, extra
  segments) → regex fails → generic 404.
- Trailing slash tolerated (`/?$` in each regex).
- Desktop/iOS → Play Store link only (no dead intent button).

## Limitations (documented, accepted)

- **Still HTTP 404.** GitHub Pages serves `404.html` with a 404 status for unmatched paths and offers
  no way to return 200. The page already sets `<meta name="robots" content="noindex">`, and the user
  sees a real landing, so the status code is cosmetic here. Moving to a host with rewrites (Cloudflare
  Pages/Netlify) is the only way to get 200 and is out of scope.
- In-app webviews that block both App Links **and** `intent://` (rare, heavily locked-down ones) will
  still only get the Play Store link — which is the correct graceful floor.

## Testing

No JS test harness exists in this repo (static site, no `package.json`). Verification:

- Code review of the pure `classifyPath` + open-URL builder against the regexes and the sample paths
  below.
- Manual: keep `classifyPath` a global pure function so it can be exercised directly in the devtools
  console (`classifyPath('/group/join/abc123')` etc.) with no test-only production code; spot-check the
  rendered variant by loading the deployed path (or editing `location.pathname` expectations in
  devtools). Confirm group/profile/post render their variant and that `/`, `/group/join/`, `/nope`
  fall through to the generic 404.
- Sample paths: `/group/join/abc123` → group; `/profile/alice.bsky.social` → profile;
  `/profile/alice.bsky.social/post/3kxyz` → post; `/group/join/` → generic; `/oauth` → (real page,
  never reaches 404); `/<script>` → generic.

## Conventions

Conventional Commits (commitlint + pre-commit are configured), lowercase-leading subjects. Single PR
against `main`.

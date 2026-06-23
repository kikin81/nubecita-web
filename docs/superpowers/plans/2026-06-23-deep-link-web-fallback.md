# Deep-link Web Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dead 404 on Nubecita deep links (`/group/join/{code}`, `/profile/{handle}`, `/profile/{handle}/post/{rkey}`) into an "Open in Nubecita / Get the app / View on Bluesky" landing, entirely inside the static `404.html`.

**Architecture:** GitHub Pages serves `404.html` for any unmatched path; an inline `<script>` classifies `location.pathname` client-side and, on a match, hides the generic 404 markup and reveals a pre-authored hidden `.invite` block (progressive enhancement — no match / no JS keeps today's page). All action copy is static in HTML; JS only toggles `hidden` and sets `.href`/`.textContent`, so no user input ever reaches the DOM.

**Tech Stack:** Plain HTML/CSS/JS (no build, no `package.json`). Reuses existing `colors_and_type.css` / `styles.css` tokens + `.btn`/`.btn--filled`/`.play-badge` classes + `assets/google-play-badge.png`. Conventional Commits (commitlint + pre-commit configured).

**Spec:** `docs/superpowers/specs/2026-06-23-deep-link-web-fallback-design.md` · **PR:** #21 · **Branch:** `feat/deep-link-web-fallback`.

---

## File structure

- **Modify only `404.html`** — add (a) a `.invite` CSS block in the existing `<style>`, (b) a hidden `<main class="invite" id="invite" hidden>` block after the existing `.not-found` main, (c) an inline `<script>` before `</body>`.

The current `.not-found` markup and styles stay untouched (the default the script hides only on a deep-link match).

---

## Task 1: `.invite` markup + styles (hidden, inert)

**Files:**
- Modify: `404.html`

- [ ] **Step 1: Add the `.invite` styles** inside the existing `<style>` block in `<head>`, after the `.not-found__link:hover` rule:

```css
    .invite {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 48px 24px;
      box-sizing: border-box;
    }
    .invite__mark { width: 88px; height: 88px; margin-bottom: 28px; }
    .invite__title {
      font-family: "Fraunces", serif;
      font-weight: 600;
      font-size: clamp(28px, 5vw, 40px);
      line-height: 1.1;
      letter-spacing: -0.02em;
      margin: 0 0 12px;
      color: var(--md-sys-color-on-surface, #1a1c1e);
    }
    .invite__subtitle {
      font-size: clamp(16px, 2.2vw, 19px);
      line-height: 1.5;
      margin: 0 0 32px;
      color: var(--md-sys-color-on-surface-variant, #44474e);
      max-width: 420px;
    }
    .invite__actions {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .invite__note {
      font-size: 15px;
      color: var(--md-sys-color-on-surface-variant, #44474e);
      margin: 0;
    }
    .invite__hint {
      font-size: 14px;
      line-height: 1.5;
      color: var(--md-sys-color-on-surface-variant, #44474e);
      max-width: 360px;
      margin: 20px 0 0;
    }
    .invite__back {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 28px;
      font-size: 16px;
      color: var(--sky-50, #0A7AFF);
      text-decoration: none;
      border-bottom: 1px solid currentColor;
      padding-bottom: 2px;
    }
    .invite__back:hover { opacity: 0.8; }
```

- [ ] **Step 2: Add the hidden `.invite` markup** immediately AFTER the closing `</main>` of the existing `.not-found` block (and before `</body>`). Copy the cloud SVG verbatim from the `.not-found` block (same `<svg ... viewBox="0 0 108 108">…</svg>`), changing only its class to `invite__mark`:

```html
  <main class="invite" id="invite" hidden>
    <svg class="invite__mark" viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nubecita cloud">
      <g transform="translate(22, 32)">
        <circle cx="18" cy="26" r="14" fill="#0A7AFF"/>
        <circle cx="34" cy="20" r="18" fill="#0A7AFF"/>
        <circle cx="52" cy="26" r="14" fill="#0A7AFF"/>
        <rect x="10" y="30" width="48" height="14" rx="7" fill="#0A7AFF"/>
        <path d="M 24 22 q 3 -3 6 0" stroke="#FFFFFF" stroke-width="2.4" fill="none" stroke-linecap="round"/>
        <path d="M 38 22 q 3 -3 6 0" stroke="#FFFFFF" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      </g>
    </svg>
    <h1 class="invite__title" id="inviteTitle"></h1>
    <p class="invite__subtitle" id="inviteSubtitle"></p>
    <div class="invite__actions">
      <a id="actOpenApp" class="btn btn--filled" hidden>Open in Nubecita</a>
      <a id="actBluesky" class="btn btn--filled" rel="noopener" hidden>View on Bluesky Web</a>
      <a id="actPlay" class="play-badge" href="https://play.google.com/store/apps/details?id=net.kikin.nubecita" rel="noopener" hidden>
        <img src="/assets/google-play-badge.png" alt="Get it on Google Play" width="207" height="80">
      </a>
      <p id="actAndroidNote" class="invite__note" hidden>Nubecita is an Android app.</p>
    </div>
    <p class="invite__hint" id="inviteHint" hidden>Nothing happening? Tap the &vellip; menu and choose &ldquo;Open in browser&rdquo; (Chrome).</p>
    <a href="/" class="invite__back">&larr; Back to nubecita.app</a>
  </main>
```

Note: every action element is `hidden` by default; the script unhides exactly the right ones. `inviteTitle`/`inviteSubtitle` are empty and filled (with static per-variant strings) by the script. The escape-hatch hint and the back link are static copy.

- [ ] **Step 3: Verify the page still renders the generic 404 untouched**

Open `404.html` in a browser (or `python3 -m http.server` from the repo root, then visit `/nonexistent`). Expected: the `.not-found` "404 drifted off" page renders exactly as before; the `.invite` block is present in the DOM but `hidden` (invisible). No script yet, so nothing activates.

- [ ] **Step 4: Commit**

```bash
git add 404.html
git commit -m "feat(404): add hidden invite-landing markup and styles"
```

---

## Task 2: deep-link classification + activation script

**Files:**
- Modify: `404.html`

- [ ] **Step 1: Add the inline `<script>`** immediately before `</body>` (after the `.invite` `<main>`):

```html
  <script>
    // Deep-link web fallback. GitHub Pages serves this 404.html for any unmatched
    // path; classify the path and, on a match, swap the generic 404 for an
    // "open in app" landing. All copy is static; the path is never written to the
    // DOM (XSS-safe). See docs/superpowers/specs/2026-06-23-deep-link-web-fallback-design.md
    var PLAY_URL = "https://play.google.com/store/apps/details?id=net.kikin.nubecita";

    // Pure + global (console-testable): returns "group" | "profile" | "post" | null.
    // Post is checked before profile because both start with /profile/.
    function classifyPath(pathname) {
      if (/^\/group\/join\/[A-Za-z0-9._-]+\/?$/.test(pathname)) return "group";
      if (/^\/profile\/[^/]+\/post\/[^/]+\/?$/.test(pathname)) return "post";
      if (/^\/profile\/[^/]+\/?$/.test(pathname)) return "profile";
      return null;
    }

    // Pure: Android intent-scheme open-or-fallback URL for an already-validated path.
    function intentUrl(pathname) {
      return "intent://nubecita.app" + pathname +
        "#Intent;scheme=https;package=net.kikin.nubecita;S.browser_fallback_url=" +
        encodeURIComponent(PLAY_URL) + ";end";
    }

    var COPY = {
      group:   { title: "You're invited to a group", subtitle: "Open this invite in the Nubecita app.", docTitle: "Nubecita — Group invite" },
      profile: { title: "View this profile on Nubecita", subtitle: "Open it in the Nubecita app.",       docTitle: "Nubecita — Profile" },
      post:    { title: "View this post on Nubecita",    subtitle: "Open it in the Nubecita app.",        docTitle: "Nubecita — Post" }
    };

    (function () {
      var variant = classifyPath(location.pathname);
      if (!variant) return; // unmatched -> leave the generic 404 in place

      var copy = COPY[variant];
      document.title = copy.docTitle; // set before gtag so GA4 doesn't bury it under the 404 page_view

      document.getElementById("inviteTitle").textContent = copy.title;
      document.getElementById("inviteSubtitle").textContent = copy.subtitle;

      var isAndroid = /android/i.test(navigator.userAgent);
      var openApp = document.getElementById("actOpenApp");
      var bluesky = document.getElementById("actBluesky");
      var play = document.getElementById("actPlay");
      var androidNote = document.getElementById("actAndroidNote");
      var hint = document.getElementById("inviteHint");

      if (isAndroid) {
        openApp.href = intentUrl(location.pathname);
        openApp.hidden = false;
        play.hidden = false; // secondary "Get it on Google Play"
        // In-app webviews (Instagram/FB/Line) silently swallow intent://. If we're
        // still foreground 1.5s after the tap, surface the break-out instruction.
        openApp.addEventListener("click", function () {
          setTimeout(function () {
            if (!document.hidden) hint.hidden = false;
          }, 1500);
        });
      } else if (variant === "profile" || variant === "post") {
        bluesky.href = "https://bsky.app" + location.pathname; // 1:1 AT-Proto URL mapping; host hard-coded
        bluesky.hidden = false;
        play.hidden = false; // secondary: get the Android app
      } else {
        // non-Android group invite: no bsky.app equivalent -> Play Store only
        androidNote.hidden = false;
        play.hidden = false;
      }

      document.getElementById("notFound").hidden = true; // hide the generic 404 block
      document.getElementById("invite").hidden = false;

      if (typeof gtag === "function") {
        gtag("event", "deep_link_fallback", {
          link_type: variant,
          platform: isAndroid ? "android" : "other",
          page_title: copy.docTitle
        });
      }
    })();
  </script>
```

- [ ] **Step 2: Give the existing `.not-found` `<main>` an `id`** so the script can hide it. In the existing markup, change:

```html
  <main class="not-found">
```
to:
```html
  <main class="not-found" id="notFound">
```

- [ ] **Step 3: Verify classification logic** (the pure function, no browser needed)

Run with whatever's available; node ships on most dev machines:
```bash
node -e '
function classifyPath(p){if(/^\/group\/join\/[A-Za-z0-9._-]+\/?$/.test(p))return"group";if(/^\/profile\/[^/]+\/post\/[^/]+\/?$/.test(p))return"post";if(/^\/profile\/[^/]+\/?$/.test(p))return"profile";return null}
[["/group/join/abc123","group"],["/profile/alice.bsky.social","profile"],["/profile/alice.bsky.social/post/3kxyz","post"],["/profile/did:plc:abc/post/3k","post"],["/group/join/","null"],["/","null"],["/oauth","null"],["/profile/a/post/b/c","null"],["/%3Cscript%3E","null"]].forEach(function(t){var g=classifyPath(t[0]);var ok=String(g)===t[1];console.log((ok?"PASS":"FAIL"),t[0],"->",g)})
'
```
Expected: every line `PASS` (group/profile/post classify correctly; the malformed/unknown/`<script>` paths → `null`). If `node` is unavailable, paste `classifyPath` into the browser devtools console and call it on each sample path.

- [ ] **Step 4: Verify activation in a browser**

Serve the repo (`python3 -m http.server 8000`) and visit:
- `http://localhost:8000/group/join/abc123` → group invite landing; on a non-Android UA, the Play badge + "Nubecita is an Android app." note (no bsky button). (Local server returns the file for missing paths only if configured; if it 404s without serving `404.html`, instead open `404.html` directly and in the console run the IIFE's body against a stubbed `location.pathname`, or use devtools "Override" — the node check in Step 3 is the authoritative logic test.)
- Confirm `/` and `/nope` still show the generic 404 (the `#invite` block stays hidden, `#notFound` visible).
- Toggle a mobile Android UA in devtools and confirm the "Open in Nubecita" button appears with an `intent://…` href.

- [ ] **Step 5: Commit**

```bash
git add 404.html
git commit -m "feat(404): route deep links to an open-in-app landing"
```

---

## Task 3: review, gate, ship

- [ ] **Step 1: Static self-review of `404.html`**

Confirm:
- `location.pathname` is used everywhere (never `location.href`); query/hash are therefore dropped.
- The path is only used in `intentUrl(...)` and the `bsky.app` href — both AFTER `classifyPath` returns non-null; it is never `innerHTML`/`textContent`'d.
- All visible copy (`COPY`, the static `<a>`/`<p>` text) is literal — no interpolation of the path.
- Hard-coded hosts: `intent://nubecita.app…`, `https://bsky.app…`, `PLAY_URL`. `package=net.kikin.nubecita` pins the app.
- The generic 404 (`#notFound`) is the default; only hidden on a match.

- [ ] **Step 2: Run pre-commit**

```bash
pre-commit run --files 404.html
```
Expected: PASS (commitlint runs on the commit messages, which are lowercase-leading Conventional subjects; any HTML/whitespace hooks pass). Fix + re-commit if a hook reformats.

- [ ] **Step 3: Push + mark PR ready**

```bash
git push
gh pr ready 21
```

- [ ] **Step 4: Request Gemini review** (Gemini Code Assist is active on the kikin81 org — the diff now contains the implementation, so this reviews the real code, per the gemini-review-only-on-pr-open learning)

```bash
gh pr comment 21 --body "/gemini review"
```

- [ ] **Step 5: Watch checks + triage**

`gh pr checks 21` (this repo's CI is light — pre-commit/lint at most). Address any Gemini findings (reply + resolve, or fix), then it's ready to merge.

---

## Self-review notes

- **Spec coverage:** `classifyPath` strict regexes + pathname-only + DID support (T2 S1/S3) ✓; DOMContentLoaded-equivalent IIFE classify → hide `#notFound`/show `#invite`, set `document.title`, gtag with `page_title` (T2 S1) ✓; `.invite` landing reusing tokens + cloud SVG + variant copy (T1) ✓; platform×variant primary action — Android intent open-or-Play, non-Android profile/post→bsky.app, non-Android group→Play+note (T2 S1) ✓; in-app webview 1500ms escape hatch (T2 S1) ✓; security: no path in DOM, intent/bsky built from validated path via property assignment (T2 S1 + T3 S1) ✓; progressive-enhancement default 404 (T1, `#notFound` only hidden on match) ✓; HTTP-404 limitation accepted (no code) ✓.
- **No placeholders:** every step has complete code (the full `<style>`, `<main>`, and `<script>` blocks) and exact commands.
- **Consistency:** ids `notFound`/`invite`/`inviteTitle`/`inviteSubtitle`/`actOpenApp`/`actBluesky`/`actPlay`/`actAndroidNote`/`inviteHint`, the `classifyPath`/`intentUrl`/`COPY`/`PLAY_URL` names, and the regexes are identical across T1↔T2↔T3.
- **The IIFE runs at parse time before `</body>`** — the `.invite`/`.not-found` DOM above it already exists, so no `DOMContentLoaded` wrapper is needed (the script tag is the last element). `gtag` is defined by the head snippet, guarded by `typeof gtag === "function"`.

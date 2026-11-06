# Reporting a problem from a provider card

Every card in the providers grid carries one quiet control: **报告问题** (Report a
problem). It exists because the honest states on those cards — `pending`,
`blocked`, "this flow has not been verified in 私密登录 yet" — are exactly
the ones a user hits first, and until now there was no way to tell us.

The goal is that reporting costs a few clicks and no writing: the body is
already written, the title is already written, and the user only presses
**Create** on GitHub.

## Why the service opens the browser

A magpie page cannot do this itself:

* it runs in `<iframe sandbox="allow-scripts">` — no `allow-popups`, no
  `allow-forms`, no `allow-same-origin`, no top navigation, so `window.open`,
  `<a target="_blank">` and form submission are all silently dead;
* it has no network of its own (`connect-src 'none'`), and the magpie bridge
  exposes no "open a link" call.

The plugin's own local service is the only part of this package that runs with
normal privileges on the user's machine, so it does the one thing the page
cannot: hand a finished URL to the operating system.

## The three guarantees

1. **The page cannot choose what gets posted.** `POST /api/report` takes a
   provider id and an optional note; the body is assembled on the service side
   from an allowlist (`lib/issue-report.mjs`). Credentials, account keys,
   proxy passwords and cookies are never in that allowlist, and a test asserts
   that a provider object carrying them produces a body that contains none of
   them.
2. **The page cannot widen what gets launched.** `POST /api/report/open` is the
   only route that spawns anything, and it re-checks the URL against
   `isAllowedIssueUrl`: `https:`, host `github.com`, path
   `/fenyan5312/私密登录/issues/new`, no userinfo. Everything else is a 400 and
   nothing is spawned. The URL is passed as a single argv entry — never through
   a shell — so `&` in a query string cannot become another command.
3. **Nothing is posted automatically.** The service opens the GitHub form with
   the title and body filled in; the user reads it and presses Create. There is
   no token in the plugin and no background POST to the GitHub API. A token
   shipped inside a distributed plugin would be readable by every user, which
   is why the `gh` route was rejected even though the CLI exists on some
   machines.

## What the report contains

The card as the user sees it (id, name, state and its reason, description,
notice, sign-in methods, list sources, plugin entry), the environment
(clean-login version, plugin-scan state, OS and arch, runtime, timestamp), and
the user's optional note. The note is percent-encoded against the real launch
budget: CJK prose costs nine characters per glyph and an emoji twelve, so the
service shrinks the note until the finished URL fits, and the dialog says when
it did.

## Files

* `lib/issue-report.mjs` — allowlist, body assembly, URL builder, URL check.
* `lib/open-external.mjs` — the single hand-off to the OS
  (`explorer.exe` / `open` / `xdg-open`).
* `lib/server.mjs` — `POST /api/report`, `POST /api/report/open`.
* `ui/app.js` — the card control and the dialog.
* `test/issue-report.test.mjs`, `test/open-external.test.mjs`,
  `test/report-route.test.mjs` — the allowlist, the spawn shape, and the routes
  over real HTTP.

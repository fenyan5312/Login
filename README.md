# Login

**One magpie page for proxy exits, isolated-browser sign-ins and your account ledger — plus WorkBuddy credential import, in the same plugin.**

Every account gets its own browser profile, its own pinned fingerprint and the proxy you pick for it. Sign-in pages never open in your everyday browser, and two accounts of the same provider never look like the same machine.

> **Unofficial plugin.** Login is built and maintained at [fenyan5312/Login](https://github.com/fenyan5312/Login). It is **not** a package published by `magpie-community`, and nobody has reviewed it but you. Read the code, open an issue, send a pull request — all three are welcome.

> **作者 / Author:** 筱玖could · 微信 / WeChat: `xiao9-c`

<sub>中文简介：在一个页面里管理代理出口、各家供应商的登录和账号账本。每个账号都用自己的浏览器身份、固定的浏览器指纹，以及你指定的代理完成登录；WorkBuddy 还支持直接粘贴凭据导入，不必再开一次浏览器。登录页不会进入你日常用的浏览器，同一个供应商的两个账号也不会被看成同一台机器。</sub>

---

## Features

- **Every provider magpie knows, in one list.** Login reads the provider plugins you have installed *and* magpie's own provider list, then merges them with its local registry. Nothing is hidden behind a category you have to guess — the full roster is listed, with the sign-in routes each provider actually exposes.
- **Pick the way you sign in.** When a provider offers several routes — a login page per site, a team plan, reusing the desktop app's session, pasting a token — you choose, and Login says what kind each route is before you start.
- **Paste a credential for any provider.** WorkBuddy keeps its four native methods, and Login adds a fifth: paste a credential JSON, a Cookie header, a curl command, a refresh token or an API key. Every other provider in the list gets the same entry: Login detects a key or token, keeps only the typed fields magpie stores, refuses duplicates, and never logs or forwards the secret. A WorkBuddy refresh token is spent once to prove it; for providers with no safe endpoint to call, Login says so instead of claiming a check it did not run.
- **One proxy per account.** Choose the exit in the add-account dialog and the login browser really uses it.
- **Test an exit before you trust it.** A real connection through the proxy reports the exit IP, its region and the latency. No direct-connection fallback: if it fails, you see why.
- **Trust score per exit.** Read the Claude IP trust score that page publishes, opened through that very proxy, and keep the number next to the row.
- **Accounts keep their identity.** Signing an account out does not throw its browser identity away — signing back in reuses the same one.
- **Everything stays on this computer.** Proxies, accounts and browser profiles live in your own magpie folder. Stored proxy passwords are never shown to the page and never written to a log. An imported credential exists in memory for the length of one request.
- **Four languages.** English, 简体中文, 繁體中文 and 日本語, following magpie's own language setting.
- **A dark-glass UI.** Frosted panels with real backdrop blur, Mac-style pop-up menus that you can actually read, keyboard support and a light theme, all built on design tokens.

## Install

1. Open magpie → **Plugins** → **Discover** → **Unofficial**.
2. Find **Login** by **fenyan5312** and press **Install**.
3. Open **Login** from the sidebar.

If the list has not caught up yet, use **Retry** — magpie caches what GitHub told it. You can also install from a local checkout with `magpie plugin add ./Login`.

> Requires **Windows x64** today. The plugin downloads a stripped-down browser runtime built for Windows; other platforms are not supported yet.

## Getting started

The first time you sign in, Login downloads its own browser runtime — about **170 MB**, once. Everything after that runs offline from your machine.

1. **Proxy IPs** → add the exits you want to log in through.
2. Press **Test** on each one and check the exit IP and region look right. Add a trust score if you want a second opinion.
3. **Providers** → pick a provider → choose its proxy → **Add account**.
4. A separate browser window opens. Sign in there as usual; it finishes by itself and the account appears in magpie. Close the window to cancel instead.

For WorkBuddy you can skip the browser: **Accounts** → **导入凭据**, paste the credential, press **校验并导入**. Any other provider card without a runnable sign-in method offers the same dialog, scoped to that provider; the kind is detected automatically.

## Good to know

- **Each account is its own browser.** Profiles, fingerprints and cookies belong to one account and are never shared, so signing in twice never merges two identities.
- **A provider needs a sign-in route.** When no installed plugin exposes a runnable method, the card still offers **Add account**, which opens the paste dialog for that provider. If magpie itself does not list the provider, the account is written but magpie has nothing to use it for yet, and the card says so.
- **The plugin follows magpie.** It uses the provider plugins you already installed and magpie's provider list, so a provider you add to magpie shows up here too.
- **Nothing is shared with anyone.** There is no telemetry and no account: the only network calls are the ones you start — the proxy test, the trust score page, the WorkBuddy token refresh and the provider's own sign-in page.

## Something wrong?

Open an [issue](https://github.com/fenyan5312/Login/issues) and say what you expected, what happened, and which provider or proxy was involved. A screenshot of the message is worth a lot. Please do not paste real tokens or proxy passwords into an issue.

Pull requests are welcome. [`bun test`](package.json) runs the whole suite; a change without a test is a change nobody can trust later.

## Credits

Login merges two MIT-licensed projects:

- [Gruu6y/clean-login](https://github.com/Gruu6y/clean-login) — the page, proxy/account model, isolated browser runtime and sign-in flow.
- [fenyan5312/magpie-wpt](https://github.com/fenyan5312/magpie-wpt) — the WorkBuddy provider and credential import.

Maintained by **筱玖could** — 微信: `xiao9-c`.

Both copyright notices are kept in [LICENSE](LICENSE).

## License

[MIT](LICENSE).

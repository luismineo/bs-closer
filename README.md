# BS Closer

A lightweight Microsoft Edge extension (Manifest V3) that cuts down on web annoyances. It runs on every page and:

- **Rejects cookies** where it can. It runs [DuckDuckGo's autoconsent](https://github.com/duckduckgo/autoconsent) rule set first, which covers hundreds of consent platforms. When those rules don't apply, it falls back to its own framework-specific selectors for OneTrust, Cookiebot, Usercentrics, TrustArc and Didomi, then to text matching in English and Brazilian Portuguese.
- **Acknowledges notice banners**: cookie banners whose only button is "OK", "Got it" or "Entendi" get that button clicked, so they stop coming back.
- **Closes popups**: newsletter and email-capture modals, survey requests, marketing overlays, chat welcome bubbles, app-download banners, and notification prompts that the site draws itself.
- **Hides leftover overlays** and **turns page scrolling back on** when a popup locked it.
- **Watches for content that loads later** with a throttled `MutationObserver`.

It needs no permissions beyond running on pages: no background worker, storage or network access. It requires Edge 111 or later.

## Project structure

```
bs-closer/
├── manifest.json                 # MV3 manifest: content scripts on all http/https pages and frames
├── content.js                    # All BS Closer logic. The CONFIG block at the top holds every keyword and selector
├── styles.css                    # Rules for elements the extension hides and for restoring scroll
├── vendor/autoconsent/           # DuckDuckGo autoconsent (MPL-2.0), generated; don't edit by hand
│   ├── autoconsent.js            #   the library, runs in the extension's isolated world
│   ├── rules.js                  #   DuckDuckGo's compact consent-platform rule set
│   ├── eval-bridge.js            #   page-world helper that runs the library's fixed snippets by id
│   └── LICENSE                   #   Mozilla Public License 2.0
├── scripts/update-autoconsent.mjs  # Re-generates vendor/autoconsent from the npm package
├── temp/                         # Local notes and plans (git-ignored)
└── README.md
```

## Installation (Edge Developer Mode)

1. Open `edge://extensions` in Microsoft Edge.
2. Turn on **Developer mode** (toggle in the left sidebar, or bottom-left on narrow windows).
3. Click **Load unpacked**.
4. Select the `bs-closer` folder, the one that contains `manifest.json`.
5. The extension appears as **BS Closer** and starts working on newly loaded pages. Reload any tabs that were already open.

**After editing the code**, click the **Reload** (↻) icon on the extension's card in `edge://extensions`, then reload the page.

> On a company-managed Edge, policy may block unpacked extensions. If **Load unpacked** is missing or greyed out, ask IT.

## Seeing what it does

Open DevTools (F12) → **Console**. Every action is logged with a `[BS Closer]` prefix:

```
[BS Closer] Active.
[BS Closer] DuckDuckGo rules: didomi detected.
[BS Closer] DuckDuckGo rules: didomi banner found, opting out.
[BS Closer] DuckDuckGo rules: didomi opt-out succeeded.
[BS Closer] OneTrust detected.
[BS Closer] Click (OneTrust reject via selector): <button#onetrust-reject-all-handler> "Reject All"
[BS Closer] Click (cookie notice acknowledged via text "entendi"): <button> "Entendi"
[BS Closer] Click (popup close via text "agora nao"): <button> "Agora não"
[BS Closer] Hidden (annoyance popup): <div#app-banner.promo-banner> "Download the app…"
[BS Closer] Restored scrolling on <body>.
```

Elements the extension hid stay in the DOM with a `data-bs-closer-hidden="<reason>"` attribute. You can inspect them in the Elements panel.

To silence the logs, set `CONFIG.DEBUG = false` in `content.js`.

## How it works

**DuckDuckGo autoconsent runs first.** When the page loads, BS Closer starts DuckDuckGo's library with its rule set, configured to opt out only. The library detects the consent platform (CMP), finds its banner and runs that CMP's opt-out steps. These can be multi-step: open settings, untick purposes, save. For CMPs with no opt-out, it hides the banner. While the library is still detecting (up to 1.5 s after a banner appears) or is opting out, BS Closer's own consent handling waits. If the library finds nothing or its opt-out fails, BS Closer takes over as described below. Popups other than consent banners are always handled by BS Closer.

Some rules need to read the page's JavaScript state, for example to call Didomi's API. Content scripts can't see that state, so `vendor/autoconsent/eval-bridge.js` runs in the page's world. It holds the library's fixed snippet functions and runs one by id when asked. It never runs code that it receives.

After that, each scan, throttled to at most one every 700 ms and run when the browser is idle, does the following:

1. **Framework consent handling.** For each supported CMP it looks for that framework's own reject button, such as `#onetrust-reject-all-handler` or `#CybotCookiebotDialogBodyButtonDecline`. Usercentrics' shadow DOM is searched too. If there is no such button, it falls back to text matching inside the banner. If the banner still has no reject option after a short wait, it is acknowledged if it is a notice banner (see below) or hidden otherwise.
2. **Known widgets.** It clicks "cancel" on OneSignal push prompts and hides Branch.io and smart app banners and Intercom welcome bubbles.
3. **Generic containers.** It finds visible elements that look like consent banners or popups: `role="dialog"`, `aria-modal`, and classes or IDs containing `cookie`, `consent`, `modal`, `popup`, `overlay`, `backdrop`, `lightbox`, `newsletter`, `banner` and so on. For popups, the element (or a parent) must be floating, meaning `position: fixed` or `sticky`.
   - **Consent banners:** click a reject-style button. With no reject option, a notice banner is acknowledged and any other banner is hidden. The banner's "X" is never clicked, because on some sites closing counts as consent.
   - **Notice banners** offer no choice at all. Every control in them is an acknowledgment: "OK", "Got it", "Understood", "Entendi", "Ciente" (exact labels from `ACKNOWLEDGE_KEYWORDS`), or an × icon. Links that navigate away, such as "Privacy policy", don't count. Clicking the acknowledgment changes nothing about what the site does, and the site stores the dismissal, so the banner stops coming back. If any other control is present (say "Accept" next to "Settings"), the banner offers a real choice and is not a notice.
   - **Popups:** click a close-style button, found by text, then by `aria-label`/class (`close`, `dismiss`, `data-dismiss`…), then by icon glyphs (`×`, `✕`…). With no close button, the popup is hidden only if it is clearly an annoyance (newsletter, discount, app or notification wording), a full-screen modal, or an empty backdrop left behind.
4. **Scroll restore.** Shortly after an action, it removes scroll-lock classes such as `modal-open` and `no-scroll`, overrides `overflow: hidden` / `overflow-y: hidden` on `<html>`/`<body>`, and undoes the `body { position: fixed }` lock while keeping your scroll position.

Elements are **hidden, not removed**, because pulling nodes out from under React or Vue can crash a page.

## Safety rules

| Rule | How it's enforced |
|---|---|
| Never touch login forms | Anything inside a form, or a container, that has password, one-time-code or credit-card inputs is skipped entirely |
| Never submit forms | `input[type=submit]` and submit buttons inside a `<form>` are never clicked |
| Never click dangerous buttons | Labels are checked against `DANGEROUS_KEYWORDS`: subscribe, buy, checkout, pay, confirm, delete, account, login, sign up and similar, plus PT-BR equivalents such as assinar, comprar, pagar, confirmar, excluir, conta and entrar |
| Never navigate away | Links are clicked only when `href` is `#` or `javascript:` |
| Skip identity providers | The extension is fully disabled on Microsoft, Google accounts, Okta, Auth0, Ping, OneLogin, Duo, Cognito, Apple ID, gov.br and similar, and on hosts starting with `login.`, `sso.`, `auth.`, `accounts.`… |
| Skip banking and payments | Disabled on PayPal, Stripe, Mercado Pago, major Brazilian and US banks, and any host containing `bank`/`banco` |
| Skip sensitive pages | Disabled on paths like `/login`, `/signin`, `/checkout`, `/payment`, `/account`, `/minha-conta`. This is re-checked on every scan, so it also covers single-page-app navigation |
| Don't fight the user | Dialogs that appear within 2 s of a real user click or Enter/Space press are treated as user-opened and left alone |
| No repeat clicks | Clicked elements are remembered in a `WeakSet`, and each page has a budget of 40 actions |
| Reject before accept | "Accept" is **never** clicked by default (see `ACCEPT_AS_LAST_RESORT` and `ACKNOWLEDGE_LONE_ACCEPT`). A notice banner's "OK" is clicked only when no reject option exists and the banner has no other choice |
| DuckDuckGo rules only opt out | The library runs with `autoAction: 'optOut'`, only on pages where BS Closer is active, and only acts on the CMPs its rules recognise. It clicks those CMPs' own controls itself, so the per-click checks above don't apply to its clicks |
| Context matters | "Reject" or "Close" buttons are only clicked inside a detected consent banner or popup, never anywhere else on the page |

To make the extension ignore part of a page, add `data-bs-closer-ignore` to an element.

## Configuration

Everything lives in the `CONFIG` object at the top of `content.js`:

| Setting | Purpose |
|---|---|
| `REJECT_KEYWORDS`, `CLOSE_KEYWORDS`, `ACCEPT_KEYWORDS` | Button labels to match. Write them naturally ("Não Aceitar"): matching ignores case, accents, punctuation and surrounding whitespace |
| `DANGEROUS_KEYWORDS` | Labels that are never clicked, matched as whole words |
| `ANNOYANCE_KEYWORDS` | Text that allows hiding a popup that has no close button |
| `CONSENT_CONTAINER_SELECTORS`, `POPUP_CONTAINER_SELECTORS` | How containers are detected |
| `KNOWN_DISMISS_SELECTORS`, `KNOWN_HIDE_SELECTORS` | Specific widgets to click away or hide |
| `SKIP_DOMAINS`, `SKIP_HOST_PREFIXES`, `SKIP_HOST_KEYWORDS`, `SKIP_PATH_PATTERN` | Where the extension stays off |
| `ACCEPT_AS_LAST_RESORT` | `true` clicks "Accept" when no reject option exists, so the banner won't return. Default is `false`, which hides the banner instead |
| `ACKNOWLEDGE_NOTICE_BANNERS`, `ACKNOWLEDGE_KEYWORDS` | Click "OK"-style buttons on banners that offer no choice (default `true`). Labels must match exactly, so "Continue with all cookies" never counts |
| `ACKNOWLEDGE_LONE_ACCEPT` | Also treat a banner whose only button is "Accept" as a notice. Default is `false`: unlike "OK", the label says you consent, and some sites act on it |
| `AUTOCONSENT_ENABLED` | Run DuckDuckGo's rule set before BS Closer's own consent handling (default `true`) |
| `AUTOCONSENT_HEURISTIC_MODE` | DuckDuckGo's own heuristic for unknown banners: `'off'` (default, unknown banners are left to BS Closer), `'reject'`, `'tier1'` (also clicks "OK"-style buttons) or `'tier2'` (also accepts) |
| Timing values (`HIDE_DELAY_MS`, `RETRY_DELAY_MS`, `AUTOCONSENT_GRACE_MS`, …) | How long it waits before hiding, retrying or taking over from DuckDuckGo's rules |

Framework rules are in the `FRAMEWORKS` array just below `CONFIG`. Add a new CMP by copying an entry.

## Updating the DuckDuckGo rules

DuckDuckGo publishes new rules almost daily. The vendored copy is pinned in `scripts/update-autoconsent.mjs` (currently **16.43.2**). To update it, you need Node.js, npm and `tar` (built into Windows 10+):

```
node scripts/update-autoconsent.mjs            # the pinned version
node scripts/update-autoconsent.mjs 16.50.0    # a specific version
```

The script downloads the package from npm and rewrites `vendor/autoconsent/`. It wraps the library and rules so they load as plain content scripts, so the extension itself still has no build step. Bump `PINNED_VERSION` when you move to a new release, then reload the extension.

**Matching:** a label matches when it equals a keyword exactly, or starts with the keyword followed by up to 25 more characters. For example, "Reject all cookies" matches `reject all`. Labels longer than 60 characters are never matched.

## Known limitations

- **Hidden banners return.** When a banner is hidden rather than rejected or acknowledged, the site never records a choice, so the banner comes back on the next visit and gets hidden again.
- **DuckDuckGo's rules run once per page load.** After a single-page-app navigation, a newly shown banner is handled by BS Closer's own logic only.
- **Form-based consent pages are skipped.** Pages such as `consent.google.com` / `consent.youtube.com` record "Reject all" through a form submit, which the safety rules forbid, so they are left alone.
- **Cross-origin iframes:** the script runs inside frames, but only handles consent there, not popups. UI drawn in closed shadow roots can't be reached.
- **Re-applied scroll locks:** after scrolling is restored, a dialog you open later may not lock background scrolling.
- **Heuristics aren't perfect.** If a site breaks, add its domain to `SKIP_DOMAINS` or mark the element with `data-bs-closer-ignore`.
- **No icons** are included, so Edge shows a placeholder. To add some, put `icons/16.png`, `48.png` and `128.png` in the folder and reference them in an `"icons"` key in `manifest.json`.

## Credits

Cookie-consent handling is built on **[autoconsent](https://github.com/duckduckgo/autoconsent)** by [DuckDuckGo](https://duckduckgo.com), the open-source library and rule set that DuckDuckGo's browsers use to answer consent popups. Thanks to DuckDuckGo and the autoconsent contributors for building and maintaining it in the open.

autoconsent is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/). The files in `vendor/autoconsent/` are generated from the published [`@duckduckgo/autoconsent`](https://www.npmjs.com/package/@duckduckgo/autoconsent) npm package and stay under that license; its full text is in [`vendor/autoconsent/LICENSE`](vendor/autoconsent/LICENSE). The source for those files is the autoconsent repository linked above.

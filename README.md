# BS Closer

A lightweight Microsoft Edge extension (Manifest V3) that cuts down on web annoyances. It runs on every page and:

- **Rejects cookies** where it can. It runs [DuckDuckGo's autoconsent](https://github.com/duckduckgo/autoconsent) rule set first, which covers hundreds of consent platforms. When those rules don't apply, it falls back to its own framework-specific selectors for OneTrust, Cookiebot, Usercentrics, TrustArc and Didomi, then to text matching in English and Brazilian Portuguese.
- **Acknowledges notice banners**: cookie banners whose only button is "OK", "Got it" or "Entendi" get that button clicked, so they stop coming back.
- **Closes popups**: newsletter and email-capture modals, survey requests, marketing overlays, chat welcome bubbles, app-download banners, and notification prompts that the site draws itself.
- **Scores popups whose names give nothing away** (CSS-in-JS class names such as `sc-1x9f3a`, no ARIA role) by how they behave and where they sit. It closes the ones that score high enough. In this release it only logs what it would do, so the weights can be tuned first (see [The heuristic](#the-heuristic)).
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
├── tests/e2e/                    # Playwright harness and fixture pages for the heuristic (not part of the extension)
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
[BS Closer] Heuristic would close (score 14): <div.sc-nl7f2a> "× Get 10% off your first order…"
    +2 late +2 trigger +2 backdrop +2 scrollLock +1 zIndex +2 emailInput +1 closeButton +2 annoyanceText
[BS Closer] Heuristic ignored (score -7): <div.css-hd31> "Shop News Sport Tech…"
    +1 zIndex +1 placement +1 closeButton −4 siteChrome −3 content −3 initialTopBar
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
   - **Heuristic (top frame only):** anything step 3 missed is scored, as described in [The heuristic](#the-heuristic).
4. **Scroll restore.** Shortly after an action, it removes scroll-lock classes such as `modal-open` and `no-scroll`, overrides `overflow: hidden` / `overflow-y: hidden` on `<html>`/`<body>`, and undoes the `body { position: fixed }` lock while keeping your scroll position.

Elements are **hidden, not removed**, because pulling nodes out from under React or Vue can crash a page.

## The heuristic

Many sites build popups with CSS-in-JS or CSS modules. Their class names are generated (`sc-1x9f3a`, `css-7hk2`) and they often have no ARIA role, so the name-based selectors in step 3 can't find them. The heuristic finds them by behaviour and position instead.

**Finding candidates.** Each scan, it calls `document.elementsFromPoint` at five points: the viewport centre, bottom centre, bottom-right corner, top centre and left centre. For each hit it walks up to the outermost `position: fixed` ancestor (or `sticky` with a high z-index). Fixed elements newly appended to `<body>`, which is where most popup portals go, are added too. It skips anything already handled: elements step 3 found, framework banners, hidden or `data-bs-closer-ignore` elements, user-opened dialogs, consent banners (left to the consent logic), login or payment UI, and bare backdrops (a backdrop is handled together with its popup).

**Scoring.** Each candidate gets a score from these signals. Weights are in `CONFIG.HEURISTIC_WEIGHTS`:

| Signal | Weight | Fires when |
|---|---|---|
| `late` | +2 | It appeared after the page loaded (more than 1 s after start) |
| `trigger` | +2 | It appeared 3–30 s after load, or within 3 s of scrolling past 40 % or of the pointer leaving through the top edge (exit intent) |
| `backdrop` | +2 | A semi-transparent full-viewport backdrop is next to it, inside it, or is the element itself |
| `scrollLock` | +2 | `<html>`/`<body>` scrolling got locked around the time it appeared |
| `zIndex` | +1 | `z-index` ≥ 1000 |
| `placement` | +1 | A centred modal, or docked to a corner or the bottom edge. The top edge counts only for bars that appear late, such as "Free shipping today!" |
| `emailInput` | +2 | It has an email input |
| `closeButton` | +1 | It has a close or "No thanks" control |
| `annoyanceText` | +2 | Its text matches `ANNOYANCE_KEYWORDS` |
| `vendor` / `vendorOnPage` | +3 / +1 | A script or iframe from `POPUP_VENDOR_HOSTS` (Klaviyo, Privy, OptinMonster, Sumo, Justuno, Wisepops, Poptin, HubSpot, Hotjar, Sleeknote, Wheelio, OptiMonk) is inside it / anywhere on the page |
| `siteChrome` | −4 | It is, is inside, or contains `header`, `nav`, `footer` or a banner/navigation role |
| `content` | −3 | More than 8 links or 600 characters of text: real content or a menu |
| `media` | −3 | A video or audio player, or a slider |
| `otherInputs` | −5 | A search, password, address, date or file input: search overlays and forms |
| `initialTopBar` | −3 | It was there at load and is docked to the top: a sticky header or promo bar that is part of the layout |
| `liveRegion` | −2 | `role="status"`, `role="alert"` or `aria-live`: a toast you may need to read |

A candidate that appears within 2 s of your own click or key press is never scored. It counts as opened by you.

**Deciding.** With a score of `HEURISTIC_ACT_SCORE` (7) or more, BS Closer clicks the popup's close button and hides its backdrop. With no close button, it hides the popup after `HIDE_DELAY_MS`. Scrolling is then restored as usual. Every click still goes through the safety rules below and the per-page action budget.

**Modes.** `CONFIG.HEURISTIC_MODE` is `'log'` by default. In this mode the heuristic logs every candidate once, with its score and the signals that fired ("would close", "suspect" from `HEURISTIC_LOG_SCORE` (4) up, or "ignored"), and never acts. Browse normally for a while, note the false positives and misses, adjust `HEURISTIC_WEIGHTS`, then set the mode to `'act'`. `'off'` disables the heuristic.

**Per-site thresholds.** `HEURISTIC_SITE_SCORES` overrides the act score for a host and its subdomains, for example `{ 'example.com': 9 }`. A high value such as `99` stops the heuristic from acting on that site but keeps the rest of BS Closer running. Use it before resorting to `SKIP_DOMAINS`.

**Cost.** Scores are cached per element and recomputed only when the element's subtree changes. After the first score on a page, a pass takes well under 2 ms. With `DEBUG` on, each pass is recorded as a `bs-closer heuristic` entry under **Timings** in the DevTools Performance panel.

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
| Heuristic is cautious | It runs in the top frame only, never touches consent banners, and only logs until `HEURISTIC_MODE` is set to `'act'` |

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
| `HEURISTIC_MODE` | `'off'`, `'log'` (default: score and log, never act) or `'act'` |
| `HEURISTIC_ACT_SCORE`, `HEURISTIC_LOG_SCORE` | Score needed to act (7), and the lowest score logged in `'act'` mode (4) |
| `HEURISTIC_SITE_SCORES` | Per-site act score, e.g. `{ 'example.com': 9 }` |
| `HEURISTIC_WEIGHTS` | One weight per signal (see [The heuristic](#the-heuristic)), so tuning doesn't touch code |
| `POPUP_VENDOR_HOSTS` | Popup vendors whose scripts or iframes raise the score |
| Timing values (`HIDE_DELAY_MS`, `RETRY_DELAY_MS`, `AUTOCONSENT_GRACE_MS`, `HEURISTIC_TRIGGER_WINDOW_MS`, …) | How long it waits before hiding, retrying or taking over from DuckDuckGo's rules |

Framework rules are in the `FRAMEWORKS` array just below `CONFIG`. Add a new CMP by copying an entry.

## Updating the DuckDuckGo rules

DuckDuckGo publishes new rules almost daily. The vendored copy is pinned in `scripts/update-autoconsent.mjs` (currently **16.43.2**). To update it, you need Node.js, npm and `tar` (built into Windows 10+):

```
node scripts/update-autoconsent.mjs            # the pinned version
node scripts/update-autoconsent.mjs 16.50.0    # a specific version
```

The script downloads the package from npm and rewrites `vendor/autoconsent/`. It wraps the library and rules so they load as plain content scripts, so the extension itself still has no build step. Bump `PINNED_VERSION` when you move to a new release, then reload the extension.

**Matching:** a label matches when it equals a keyword exactly, or starts with the keyword followed by up to 25 more characters. For example, "Reject all cookies" matches `reject all`. Labels longer than 60 characters are never matched.

## Testing

`tests/e2e/` holds fixture pages and a Playwright runner. The fixtures are: a CSS-in-JS newsletter modal, a late promo bar, a "get the app" sheet, a chat teaser and launcher, a sticky header, a search overlay, a mini video player, a status toast, a cookie banner and a user-opened dialog. The runner loads two temporary copies of the extension into Chromium, one in `'log'` mode and one in `'act'` mode, and serves the fixtures locally. In log mode it checks each popup's verdict and score in the console. In act mode it checks which popups closed.

```
cd tests/e2e
npm install
npx playwright install chromium
npm test                 # add -- --verbose to print every [BS Closer] line
```

The harness isn't part of the extension, and it needs no build step. When adjusting `HEURISTIC_WEIGHTS`, add a fixture for the site pattern that went wrong.

## Known limitations

- **Hidden banners return.** When a banner is hidden rather than rejected or acknowledged, the site never records a choice, so the banner comes back on the next visit and gets hidden again.
- **DuckDuckGo's rules run once per page load.** After a single-page-app navigation, a newly shown banner is handled by BS Closer's own logic only.
- **Form-based consent pages are skipped.** Pages such as `consent.google.com` / `consent.youtube.com` record "Reject all" through a form submit, which the safety rules forbid, so they are left alone.
- **Cross-origin iframes:** the script runs inside frames, but only handles consent there, not popups. The heuristic also runs only in the top frame, because acting inside embedded frames could break sites. UI drawn in closed shadow roots can't be reached.
- **The heuristic only logs by default.** Unnamed popups are reported in the console but not closed until `HEURISTIC_MODE` is `'act'`. Exit-intent detection needs a mouse, which is fine for a desktop browser. Popups with `pointer-events: none`, or that sit outside the five probe points, are found only when they are appended straight to `<body>`.
- **Re-applied scroll locks:** after scrolling is restored, a dialog you open later may not lock background scrolling.
- **Heuristics aren't perfect.** If a site breaks, add its domain to `SKIP_DOMAINS` or mark the element with `data-bs-closer-ignore`.
- **No icons** are included, so Edge shows a placeholder. To add some, put `icons/16.png`, `48.png` and `128.png` in the folder and reference them in an `"icons"` key in `manifest.json`.

## Credits

Cookie-consent handling is built on **[autoconsent](https://github.com/duckduckgo/autoconsent)** by [DuckDuckGo](https://duckduckgo.com), the open-source library and rule set that DuckDuckGo's browsers use to answer consent popups. Thanks to DuckDuckGo and the autoconsent contributors for building and maintaining it in the open.

autoconsent is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/). The files in `vendor/autoconsent/` are generated from the published [`@duckduckgo/autoconsent`](https://www.npmjs.com/package/@duckduckgo/autoconsent) npm package and stay under that license; its full text is in [`vendor/autoconsent/LICENSE`](vendor/autoconsent/LICENSE). The source for those files is the autoconsent repository linked above.

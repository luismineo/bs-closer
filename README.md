# BS Closer

A lightweight Microsoft Edge extension (Manifest V3) that cuts down on web annoyances. It runs on every page and:

- **Rejects cookies** where it can, trying framework-specific selectors for OneTrust, Cookiebot, Usercentrics, TrustArc and Didomi first, then text matching in English and Brazilian Portuguese.
- **Closes popups**: newsletter and email-capture modals, survey requests, marketing overlays, chat welcome bubbles, app-download banners, and notification prompts that the site draws itself.
- **Hides leftover overlays** and **turns page scrolling back on** when a popup locked it.
- **Watches for content that loads later** with a throttled `MutationObserver`.

It needs no permissions beyond running on pages: no background worker, storage or network access.

## Project structure

```
bs-closer/
├── manifest.json   # MV3 manifest: one content script on all http/https pages and frames
├── content.js      # All logic. The CONFIG block at the top holds every keyword and selector
├── styles.css      # Rules for elements the extension hides and for restoring scroll
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
[BS Closer] OneTrust detected.
[BS Closer] Click (OneTrust reject via selector): <button#onetrust-reject-all-handler> "Reject All"
[BS Closer] Click (popup close via text "agora nao"): <button> "Agora não"
[BS Closer] Hidden (annoyance popup): <div#app-banner.promo-banner> "Download the app…"
[BS Closer] Restored scrolling on <body>.
```

Elements the extension hid stay in the DOM with a `data-bs-closer-hidden="<reason>"` attribute. You can inspect them in the Elements panel.

To silence the logs, set `CONFIG.DEBUG = false` in `content.js`.

## How it works

Each scan, throttled to at most one every 700 ms and run when the browser is idle, does the following:

1. **Framework consent handling.** For each supported CMP it looks for that framework's own reject button, such as `#onetrust-reject-all-handler` or `#CybotCookiebotDialogBodyButtonDecline`. Usercentrics' shadow DOM is searched too. If there is no such button, it falls back to text matching inside the banner. If the banner still has no reject option after a short wait, it is hidden.
2. **Known widgets.** It clicks "cancel" on OneSignal push prompts and hides Branch.io and smart app banners and Intercom welcome bubbles.
3. **Generic containers.** It finds visible elements that look like consent banners or popups: `role="dialog"`, `aria-modal`, and classes or IDs containing `cookie`, `consent`, `modal`, `popup`, `overlay`, `backdrop`, `lightbox`, `newsletter`, `banner` and so on. For popups, the element (or a parent) must be floating, meaning `position: fixed` or `sticky`.
   - **Consent banners:** click a reject-style button. With no reject option, the banner is hidden. The banner's "X" is never clicked, because on some sites closing counts as consent.
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
| Reject before accept | "Accept" is **never** clicked by default (see `ACCEPT_AS_LAST_RESORT`) |
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
| Timing values (`HIDE_DELAY_MS`, `RETRY_DELAY_MS`, …) | How long it waits before hiding or retrying |

Framework rules are in the `FRAMEWORKS` array just below `CONFIG`. Add a new CMP by copying an entry.

**Matching:** a label matches when it equals a keyword exactly, or starts with the keyword followed by up to 25 more characters. For example, "Reject all cookies" matches `reject all`. Labels longer than 60 characters are never matched.

## Known limitations

- **Hidden banners return.** When a banner is hidden rather than rejected, the site never records a choice, so the banner comes back on the next visit and gets hidden again.
- **Form-based consent pages are skipped.** Pages such as `consent.google.com` / `consent.youtube.com` record "Reject all" through a form submit, which the safety rules forbid, so they are left alone.
- **Cross-origin iframes:** the script runs inside frames, but only handles consent there, not popups. UI drawn in closed shadow roots can't be reached.
- **Re-applied scroll locks:** after scrolling is restored, a dialog you open later may not lock background scrolling.
- **Heuristics aren't perfect.** If a site breaks, add its domain to `SKIP_DOMAINS` or mark the element with `data-bs-closer-ignore`.
- **No icons** are included, so Edge shows a placeholder. To add some, put `icons/16.png`, `48.png` and `128.png` in the folder and reference them in an `"icons"` key in `manifest.json`.

/**
 * BS Closer — content script
 *
 * Runs on every page (and every frame) and:
 *   0. Starts DuckDuckGo's autoconsent rule set (vendor/autoconsent), which
 *      opts out of hundreds of known consent platforms.
 *   1. Rejects cookie consent via framework-specific selectors (OneTrust,
 *      Cookiebot, Usercentrics, TrustArc, Didomi), falling back to text matching.
 *      Banners that only say "OK" / "Got it" are acknowledged.
 *   2. Dismisses newsletter / survey / marketing / app-download / notification
 *      popups by clicking their close or "no thanks" buttons.
 *   3. Hides leftover overlays and restores page scrolling.
 *   3b. Scores unnamed floating elements (CSS-in-JS popups) by behaviour and
 *      position, and closes high scorers (logs only, by default).
 *   4. Keeps watching dynamic content with a throttled MutationObserver.
 *
 * Safety first: it never submits forms, never touches login/payment forms,
 * never clicks buttons whose label looks like purchase/subscribe/delete/account
 * actions, and stays fully disabled on identity-provider and banking sites.
 */
(() => {
  'use strict';

  // Guard against double injection (e.g. extension reloaded while the tab is open).
  if (window.__bsCloserActive) return;
  window.__bsCloserActive = true;

  /* ==========================================================================
   * CONFIGURATION
   * Every keyword is normalized at startup (lowercase, accents stripped,
   * punctuation collapsed), so write them naturally, e.g. "Não Aceitar".
   * ======================================================================== */
  const CONFIG = {
    DEBUG: true, // log every action to the console

    // Cookie banners are never "accepted" by default: if no reject option
    // exists, the banner is hidden instead. Set to true to click "Accept" as
    // a last resort (the banner then stays away on future visits).
    ACCEPT_AS_LAST_RESORT: false,

    // "Notice" banners offer no choice, only "OK" / "Got it" (maybe plus an ×).
    // Clicking it changes nothing about what the site does, and the banner stops
    // coming back on every visit, so it is clicked instead of hidden.
    ACKNOWLEDGE_NOTICE_BANNERS: true,
    // Also treat a banner whose only button is "Accept" as a notice. Off by default:
    // unlike "OK", the label says you consent, and some sites act on it.
    ACKNOWLEDGE_LONE_ACCEPT: false,

    // DuckDuckGo autoconsent (vendor/autoconsent) runs first; BS Closer's own consent
    // handling below is the fallback for banners its rules don't cover.
    AUTOCONSENT_ENABLED: true,
    // DuckDuckGo's heuristic for unknown banners: 'off', 'reject', 'tier1' (also clicks
    // "OK"-style buttons) or 'tier2' (also accepts). With 'off', unknown banners are
    // left to BS Closer's generic logic and its safety rules.
    AUTOCONSENT_HEURISTIC_MODE: 'off',

    // Heuristic for popups whose names give nothing away (top frame only, see step 3b):
    // floating elements are scored by how they behave and where they sit.
    // 'off', 'log' (score and log, never act; the default while weights are tuned) or 'act'.
    HEURISTIC_MODE: 'log',
    HEURISTIC_ACT_SCORE: 7, // close or hide at this score or above
    HEURISTIC_LOG_SCORE: 4, // in 'act' mode, lower scores aren't logged ('log' mode logs everything)
    // Per-site act score for a host or any subdomain of it, e.g. { 'example.com': 9 }.
    // A high value such as 99 keeps the heuristic from acting on that site.
    HEURISTIC_SITE_SCORES: {},
    HEURISTIC_WEIGHTS: {
      late: 2, // appeared after the page loaded
      trigger: 2, // appeared 3–30 s after load, or just after a deep scroll or exit intent
      backdrop: 2, // semi-transparent full-viewport backdrop next to or inside it
      scrollLock: 2, // page scrolling got locked when it appeared
      zIndex: 1, // z-index ≥ 1000
      placement: 1, // centred modal, or docked to a corner or the bottom (top too when late)
      emailInput: 2, // email capture
      closeButton: 1, // has a close / "no thanks" control
      annoyanceText: 2, // text matches ANNOYANCE_KEYWORDS
      vendor: 3, // script or iframe from POPUP_VENDOR_HOSTS inside it
      vendorOnPage: 1, // ...or anywhere on the page
      siteChrome: -4, // is, is inside or holds header / nav / footer
      content: -3, // more than 8 links or 600 characters: real content or a menu
      media: -3, // video/audio player or slider
      otherInputs: -5, // search, password, address… inputs: search overlays, forms
      initialTopBar: -3, // present at load and docked to the top: part of the layout
      liveRegion: -2, // role=status / alert / aria-live: toasts the user may need
    },

    MIN_SCAN_INTERVAL_MS: 700, // throttle between DOM scans
    RECHECK_DELAY_MS: 800, // follow-up scan while waiting on a banner
    HIDE_DELAY_MS: 1500, // a container must be visible this long before we hide it (lets buttons render)
    RETRY_DELAY_MS: 1500, // after a click, wait this long before hiding a container that is still visible
    USER_INTERACTION_WINDOW_MS: 2000, // popups appearing this soon after a user click are user-initiated → left alone
    SCROLL_RESTORE_WINDOW_MS: 10000, // only restore scrolling shortly after we acted
    AUTOCONSENT_GRACE_MS: 1500, // a consent banner autoconsent hasn't claimed by then is handled by BS Closer
    AUTOCONSENT_MAX_WAIT_MS: 10000, // stop waiting on an autoconsent opt-out that never reports back
    HEURISTIC_TRIGGER_WINDOW_MS: 3000, // a popup this soon after a deep scroll, exit intent or scroll lock was caused by it
    MAX_ACTIONS_PER_PAGE: 40, // safety budget: stop if a page keeps respawning popups
    MAX_LABEL_LENGTH: 60, // longer button labels are never matched
    LABEL_SLACK: 25, // "Reject all cookies" matches "reject" if the extra text is ≤ this many chars
    MAX_POPUP_TEXT_LENGTH: 5000, // bigger "popups" are probably page content
    MAX_CONSENT_TEXT_LENGTH: 25000,
    MAX_CANDIDATES_PER_SCAN: 1500,

    /* ---------- Cookie "reject" button labels (tried before anything else) ---------- */
    REJECT_KEYWORDS: [
      // English
      'Reject', 'Reject All', 'Reject All Cookies', 'Reject Cookies', 'Reject Non-Essential',
      'Reject Optional', 'Decline', 'Decline All', 'Decline Cookies', 'Deny', 'Deny All',
      'Refuse', 'Refuse All', 'Disagree', 'I Disagree', 'Do Not Accept', "Don't Accept",
      'Essential Only', 'Essentials Only', 'Only Essential', 'Essential Cookies Only',
      'Necessary Only', 'Only Necessary', 'Strictly Necessary Only', 'Necessary Cookies Only',
      'Use Necessary Cookies Only', 'Allow Necessary Only', 'Continue Without Accepting',
      'Continue Without Agreeing', 'No Thanks', 'No Thank You',
      // Português (BR)
      'Rejeitar', 'Rejeitar Todos', 'Rejeitar Tudo', 'Rejeitar Cookies', 'Rejeitar Todos os Cookies',
      'Recusar', 'Recusar Todos', 'Recusar Tudo', 'Recusar Cookies', 'Não Aceitar', 'Nao Aceitar',
      'Não Aceito', 'Não Concordo', 'Apenas Essenciais', 'Somente Essenciais',
      'Apenas Cookies Essenciais', 'Somente Cookies Essenciais', 'Apenas Necessários',
      'Apenas Necessarios', 'Somente Necessários', 'Apenas Cookies Necessários',
      'Usar Apenas Cookies Necessários', 'Continuar Sem Aceitar', 'Não Obrigado',
    ],

    /* ---------- Cookie "accept" labels (only used if ACCEPT_AS_LAST_RESORT) ---------- */
    ACCEPT_KEYWORDS: [
      'Accept', 'Accept All', 'Accept Cookies', 'Allow All', 'Agree', 'I Agree', 'OK', 'Got It',
      'Aceitar', 'Aceitar Todos', 'Aceitar Cookies', 'Aceito', 'Concordo', 'Permitir Todos', 'Entendi',
    ],

    /* ---------- Notice-banner "acknowledge" labels (exact match; see ACKNOWLEDGE_NOTICE_BANNERS) ---------- */
    ACKNOWLEDGE_KEYWORDS: [
      'OK', 'Okay', 'OK Got It', 'Got It', 'I Got It', 'Understood', 'I Understand', 'Continue',
      'Close', 'Dismiss',
      'Entendi', 'OK Entendi', 'Entendido', 'Ciente', 'Estou Ciente', 'Tudo Bem', 'Continuar',
      'Prosseguir', 'Fechar',
    ],

    /* ---------- Popup close / dismiss labels ---------- */
    CLOSE_KEYWORDS: [
      // English
      'Close', 'Close Window', 'Close Dialog', 'Close Popup', 'Close Modal', 'Close Banner',
      'Dismiss', 'No Thanks', 'No Thank You', 'Maybe Later', 'Remind Me Later', 'Later', 'Skip',
      'Not Now', 'Not Interested', 'Continue to Site', 'Continue to Website',
      // Português (BR)
      'Fechar', 'Fechar Janela', 'Fechar Anúncio', 'Fechar Popup', 'Não Obrigado', 'Nao Obrigado',
      'Não Obrigada', 'Agora Não', 'Agora Nao', 'Mais Tarde', 'Lembrar Mais Tarde', 'Pular',
      'Ignorar', 'Dispensar', 'Não Tenho Interesse', 'Continuar no Site',
    ],

    // Icon-only close buttons (compared against the raw, trimmed text).
    CLOSE_GLYPHS: ['×', '✕', '✖', '✗', '╳', '⨯', 'x'],

    // Close buttons identified by attributes rather than text (searched inside popups only).
    CLOSE_SELECTORS: [
      '[aria-label*="close" i]', '[aria-label*="fechar" i]', '[aria-label*="dismiss" i]',
      '[title*="close" i]', '[title*="fechar" i]', '[data-dismiss]', '[data-bs-dismiss]',
      '[class*="close" i]', '[class*="dismiss" i]', '[id*="close" i]',
    ],

    /* ---------- Safety: labels that must NEVER be clicked (whole-word match) ---------- */
    DANGEROUS_KEYWORDS: [
      // English
      'log in', 'login', 'sign in', 'signin', 'sign up', 'signup', 'register', 'create account',
      'my account', 'account', 'password', 'subscribe', 'subscription', 'buy', 'buy now',
      'purchase', 'order', 'place order', 'checkout', 'check out', 'pay', 'payment', 'pay now',
      'add to cart', 'add to bag', 'cart', 'donate', 'upgrade', 'start trial', 'free trial',
      'confirm', 'submit', 'send', 'delete', 'remove', 'unsubscribe', 'cancel subscription',
      'cancel order', 'transfer', 'withdraw', 'deposit',
      // Português (BR)
      'entrar', 'acessar', 'fazer login', 'cadastrar', 'cadastre se', 'cadastro', 'criar conta',
      'minha conta', 'conta', 'senha', 'inscrever', 'inscreva se', 'assinar', 'assine',
      'assinatura', 'comprar', 'compre', 'compra', 'pedido', 'finalizar', 'finalizar compra',
      'pagar', 'pagamento', 'carrinho', 'adicionar', 'doar', 'confirmar', 'enviar', 'excluir',
      'apagar', 'remover', 'deletar', 'cancelar assinatura', 'transferir', 'sacar', 'depositar',
    ],

    /* ---------- Text that marks a popup as an annoyance (safe to hide) ---------- */
    ANNOYANCE_KEYWORDS: [
      // English
      'newsletter', 'subscribe', 'sign up', 'signup', 'email', 'e mail', 'your inbox', 'discount',
      'coupon', 'promo code', '% off', 'off your first', 'offer', 'deal', 'free shipping', 'survey', 'feedback',
      'quick question', 'download the app', 'get the app', 'open in app', 'open the app',
      'use the app', 'app store', 'google play', 'notifications', 'push notifications',
      'allow notifications', 'stay updated', 'stay in the loop', 'join our', 'join now',
      'chat with us', 'how can we help', 'can we help', 'need help', 'cookie', 'cookies', 'consent',
      // Português (BR)
      'inscreva se', 'inscreva', 'assine', 'cadastre se', 'cadastre', 'receba', 'ofertas', 'oferta',
      'desconto', 'cupom', 'promoção', 'frete grátis', 'pesquisa', 'avalie', 'sua opinião', 'baixe o app',
      'baixe nosso app', 'baixar o app', 'aplicativo', 'notificações', 'ative as notificações',
      'novidades', 'fale conosco', 'posso ajudar', 'como podemos ajudar', 'privacidade', 'lgpd',
    ],

    // Text that marks a container as a cookie/consent UI.
    CONSENT_TEXT_KEYWORDS: ['cookie', 'cookies', 'consent', 'consentimento', 'gdpr', 'rgpd', 'lgpd'],

    /* ---------- Container detection ---------- */
    CONSENT_CONTAINER_SELECTORS: [
      '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
      '[id*="gdpr" i]', '[class*="gdpr" i]', '[id*="lgpd" i]', '[class*="lgpd" i]',
      '[id*="cmp" i]', '[class*="cmp" i]', '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
    ],
    POPUP_CONTAINER_SELECTORS: [
      '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog[open]',
      '[class*="modal" i]', '[id*="modal" i]', '[class*="popup" i]', '[id*="popup" i]',
      '[class*="pop-up" i]', '[class*="overlay" i]', '[id*="overlay" i]', '[class*="backdrop" i]',
      '[class*="lightbox" i]', '[id*="lightbox" i]', '[class*="newsletter" i]', '[id*="newsletter" i]',
      '[class*="interstitial" i]', '[class*="promo" i]', '[class*="banner" i]', '[id*="banner" i]',
      '[class*="survey" i]', '[class*="slidedown" i]', '[class*="flyout" i]', '[id*="onesignal" i]',
    ],
    // Containers matching these are "full-screen modals" when they cover most of the viewport.
    MODAL_SELECTORS: [
      '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog',
      '[class*="modal" i]', '[id*="modal" i]', '[class*="popup" i]', '[id*="popup" i]',
      '[class*="lightbox" i]', '[class*="interstitial" i]',
    ],

    /* ---------- Known annoyance widgets (top frame only) ---------- */
    KNOWN_DISMISS_SELECTORS: [
      '#onesignal-slidedown-cancel-button', // OneSignal push-notification prompt
      '#onesignal-popover-cancel-button',
    ],
    KNOWN_HIDE_SELECTORS: [
      '#branch-banner-iframe', '.branch-journeys-top', // Branch.io app banners
      '#smartbanner', '.smartbanner', // "Open in app" smart banners
      'iframe[name="intercom-borderless-frame"]', // Intercom welcome-message bubble
      'iframe[name="intercom-notifications-frame"]',
      '#onesignal-bell-container',
    ],

    // Popup vendors (script src or iframe host, any subdomain): a strong heuristic signal.
    POPUP_VENDOR_HOSTS: [
      'klaviyo.com', 'privy.com', 'omappapi.com', 'sumo.com', 'justuno.com', 'wisepops.com',
      'popt.in', 'hsforms.net', 'hscta.net', 'hotjar.com', 'sleeknote.com', 'wheelio-app.com',
      'optimonk.com',
    ],

    /* ---------- Classes sites add to <html>/<body> to lock scrolling ---------- */
    SCROLL_LOCK_CLASSES: [
      'modal-open', 'no-scroll', 'noscroll', 'overflow-hidden', 'scroll-lock', 'scroll-locked',
      'lock-scroll', 'disable-scroll', 'stop-scrolling', 'has-modal', 'popup-open', 'body-lock',
      'didomi-popup-open', 'reactmodal__body--open', 'sp-message-open',
    ],

    /* ---------- Sites where the extension stays completely disabled ---------- */
    // Exact host or any subdomain of it.
    SKIP_DOMAINS: [
      // Identity providers / SSO
      'login.microsoftonline.com', 'microsoftonline.com', 'login.microsoft.com', 'login.live.com',
      'login.windows.net', 'account.microsoft.com', 'account.live.com', 'msauth.net', 'msftauth.net',
      'accounts.google.com', 'myaccount.google.com', 'pay.google.com',
      'okta.com', 'oktapreview.com', 'okta-emea.com', 'okta-gov.com', 'auth0.com',
      'pingidentity.com', 'pingone.com', 'pingone.eu', 'pingone.asia', 'onelogin.com',
      'duosecurity.com', 'jumpcloud.com', 'b2clogin.com', 'amazoncognito.com',
      'appleid.apple.com', 'idmsa.apple.com', 'signin.aws.amazon.com', 'login.gov', 'id.me',
      'acesso.gov.br',
      // Payments / banking
      'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'klarna.com', 'adyen.com',
      'mercadopago.com', 'mercadopago.com.br', 'pagseguro.uol.com.br', 'pagbank.com.br',
      'picpay.com', 'nubank.com.br', 'itau.com.br', 'bradesco.com.br', 'santander.com.br',
      'bb.com.br', 'caixa.gov.br', 'inter.co', 'bancointer.com.br', 'c6bank.com.br',
      'sicredi.com.br', 'sicoob.com.br', 'btgpactual.com', 'xpi.com.br', 'chase.com',
      'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com',
      'hsbc.com', 'barclays.co.uk',
      // Heavy web apps where dialogs and overlays are part of the UI
      'office.com', 'office365.com', 'sharepoint.com', 'teams.microsoft.com', 'outlook.office.com',
      'outlook.office365.com', 'outlook.live.com', 'mail.google.com', 'docs.google.com',
      'drive.google.com', 'calendar.google.com', 'meet.google.com',
    ],
    // Hosts starting with these labels are treated as auth pages (login.example.com, sso.corp.com…).
    SKIP_HOST_PREFIXES: [
      'login.', 'logon.', 'signin.', 'sso.', 'auth.', 'idp.', 'adfs.', 'accounts.', 'account.',
      'secure.', 'id.', 'identity.', 'oauth.',
    ],
    // Hosts containing these substrings are treated as banking sites.
    SKIP_HOST_KEYWORDS: ['bank', 'banco'],
    // URL paths that indicate login, checkout, payment or account pages (checked on every scan,
    // so SPA navigations are covered too).
    SKIP_PATH_PATTERN:
      /(^|\/)(login|log-in|signin|sign-in|logon|signup|sign-up|register|oauth2?|authorize|sso|saml2?|auth|checkout|payment|payments|pay|billing|pagamento|finalizar-compra|account|my-account|minha-conta|conta)(\/|$|\.)/i,
  };

  /* ==========================================================================
   * FRAMEWORK RULES (tried before generic text matching)
   *   container  – light-DOM root(s); generic logic leaves these alone
   *   shadowHosts– hosts whose open shadow root holds the UI (Usercentrics)
   *   banner     – visible element(s) that mean "the banner is showing"
   *   reject     – reject buttons, in priority order
   *   allowHidden– reject buttons may be clicked while hidden (e.g. a
   *                preference-center button that is in the DOM but not shown)
   *   hide       – what to hide if rejecting is impossible or didn't work
   * ======================================================================== */
  const FRAMEWORKS = [
    {
      name: 'OneTrust',
      container: '#onetrust-consent-sdk, #onetrust-banner-sdk',
      banner: '#onetrust-banner-sdk, #onetrust-pc-sdk',
      reject: ['#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler'],
      allowHidden: true,
      hide: ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter'],
    },
    {
      name: 'Cookiebot',
      container: '#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay',
      banner: '#CybotCookiebotDialog',
      reject: [
        '#CybotCookiebotDialogBodyButtonDecline',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
      ],
      hide: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay'],
    },
    {
      name: 'Usercentrics',
      container: '#usercentrics-root, #usercentrics-cmp-ui',
      shadowHosts: ['#usercentrics-root', '#usercentrics-cmp-ui'],
      banner: '[data-testid="uc-default-banner"], [data-testid="uc-default-wall"], #uc-center-container, #uc-main-dialog, .cmp-wrapper, [role="dialog"]',
      reject: ['[data-testid="uc-deny-all-button"]', 'button#deny', 'button.deny', '[data-action-type="deny"]'],
      hide: ['#usercentrics-root', '#usercentrics-cmp-ui'],
    },
    {
      name: 'TrustArc',
      container: '#consent_blackbar, #truste-consent-track, #truste-consent-content, .truste_box_overlay, .truste_overlay',
      banner: '#truste-consent-track, #truste-consent-content, .truste_box_overlay',
      reject: ['#truste-consent-required', '.truste-consent-required'],
      hide: ['#consent_blackbar', '#truste-consent-track', '.truste_box_overlay', '.truste_overlay'],
    },
    {
      name: 'Didomi',
      container: '#didomi-host',
      banner: '#didomi-notice, #didomi-popup, .didomi-popup-container',
      reject: [
        '#didomi-notice-disagree-button',
        '.didomi-continue-without-agreeing',
        'button[aria-label*="disagree" i]',
      ],
      hide: ['#didomi-host'],
    },
  ];

  /* ==========================================================================
   * TEXT HELPERS
   * ======================================================================== */

  /** Lowercase, strip accents, collapse everything except letters/digits/% into single spaces. */
  function normalize(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9%]+/g, ' ')
      .trim();
  }

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Build one regex that finds any of the phrases as whole words inside normalized text. */
  function buildPhraseRegex(phrases) {
    const alternatives = [...new Set(phrases.map(normalize).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map((p) => {
        const start = /^[a-z0-9]/.test(p) ? '(?<![a-z0-9])' : '';
        const end = /[a-z0-9]$/.test(p) ? '(?![a-z0-9])' : '';
        return start + escapeRegExp(p) + end;
      });
    return alternatives.length ? new RegExp(alternatives.join('|')) : /(?!)/;
  }

  const normalizeList = (list) => [...new Set(list.map(normalize).filter(Boolean))];

  const KW = {
    reject: normalizeList(CONFIG.REJECT_KEYWORDS),
    accept: normalizeList(CONFIG.ACCEPT_KEYWORDS),
    close: normalizeList(CONFIG.CLOSE_KEYWORDS),
  };
  // Acknowledge labels must match exactly: "Continue with all cookies" is not an acknowledgment.
  const ACK_LABELS = new Set([
    ...normalizeList(CONFIG.ACKNOWLEDGE_KEYWORDS),
    ...(CONFIG.ACKNOWLEDGE_LONE_ACCEPT ? KW.accept : []),
  ]);
  const DANGER_RE = buildPhraseRegex(CONFIG.DANGEROUS_KEYWORDS);
  const ANNOYANCE_RE = buildPhraseRegex(CONFIG.ANNOYANCE_KEYWORDS);
  const CONSENT_TEXT_RE = buildPhraseRegex(CONFIG.CONSENT_TEXT_KEYWORDS);
  const CLOSE_GLYPHS = new Set(CONFIG.CLOSE_GLYPHS.map((g) => g.toLowerCase()));
  const SCROLL_LOCK_CLASSES = new Set(CONFIG.SCROLL_LOCK_CLASSES.map((c) => c.toLowerCase()));

  /**
   * Does a normalized label match one of the keywords?
   * Exact match, or the keyword followed by a little extra text
   * ("reject all cookies" matches "reject all"). Returns the keyword or null.
   */
  function labelMatches(label, keywords) {
    if (!label || label.length > CONFIG.MAX_LABEL_LENGTH) return null;
    for (const k of keywords) {
      if (label === k) return k;
      if (label.startsWith(k + ' ') && label.length - k.length <= CONFIG.LABEL_SLACK) return k;
    }
    return null;
  }

  /** Text, aria-label, title and value are all considered as an element's label. */
  function labelSources(el) {
    return [
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.tagName === 'INPUT' ? el.value : null,
    ];
  }

  function matchLabel(el, keywords) {
    for (const src of labelSources(el)) {
      const match = labelMatches(normalize(src), keywords);
      if (match) return match;
    }
    return null;
  }

  /* ==========================================================================
   * SELECTORS & STATE
   * ======================================================================== */
  const isTop = window === window.top;
  const HIDDEN_ATTR = 'data-bs-closer-hidden';
  const SCROLL_ATTR = 'data-bs-closer-scroll';
  const UNFIXED_ATTR = 'data-bs-closer-unfixed';

  const PRIMARY_CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
  const SECONDARY_CLICKABLE = '[onclick], [tabindex]:not([tabindex="-1"]), [class*="btn" i], [class*="button" i]';
  const ALL_CLICKABLE = `${PRIMARY_CLICKABLE}, ${SECONDARY_CLICKABLE}`;
  const CLOSE_SELECTOR = CONFIG.CLOSE_SELECTORS.join(', ');
  const CONSENT_SELECTOR = CONFIG.CONSENT_CONTAINER_SELECTORS.join(', ');
  const CONTAINER_SELECTOR = [...CONFIG.CONSENT_CONTAINER_SELECTORS, ...CONFIG.POPUP_CONTAINER_SELECTORS].join(', ');
  const MODAL_SELECTOR = CONFIG.MODAL_SELECTORS.join(', ');
  const FRAMEWORK_CONTAINER_SELECTOR = FRAMEWORKS.map((f) => f.container).join(', ');
  // Containers holding page structure are page content, not popups.
  const STRUCTURAL_SELECTOR = 'main, [role="main"], nav, [role="navigation"]';
  // Inputs that indicate a login or payment form — never touch anything near them.
  const SENSITIVE_INPUT_SELECTOR = [
    'input[type="password"]', 'input[autocomplete="current-password"]', 'input[autocomplete="new-password"]',
    'input[autocomplete="one-time-code"]', 'input[autocomplete^="cc-"]', 'input[name*="card" i]',
    'input[name*="cvv" i]', 'input[name*="cvc" i]',
  ].join(', ');

  const clickedElements = new WeakSet(); // never click the same element twice
  const containerInfo = new WeakMap(); // container → { firstSeen, userInitiated, clickedAt }
  const userModals = new Set(); // user-opened dialogs; while visible we don't touch scrolling
  const frameworkState = {}; // name → { firstSeen, clickedAt, userInitiated, done }

  let actionCount = 0;
  let lastActionAt = 0;
  let lastUserInteractionAt = 0;
  let lastScanAt = 0;
  let scanTimer = null;
  let needRecheck = false;
  let stopped = false;
  let observer = null;

  /* ==========================================================================
   * LOGGING
   * ======================================================================== */
  function log(...args) {
    if (!CONFIG.DEBUG) return;
    const where = isTop ? '' : ` [frame ${location.hostname}]`;
    console.log(`%c[BS Closer]${where}`, 'color:#0a84ff;font-weight:bold', ...args);
  }

  /** Short human-readable description of an element for logs. */
  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${label ? ` "${label}"` : ''}`;
  }

  /* ==========================================================================
   * PAGE-LEVEL SAFETY
   * ======================================================================== */
  function hostSkipReason(host) {
    if (!host) return null;
    host = host.toLowerCase();
    const domain = CONFIG.SKIP_DOMAINS.find((d) => host === d || host.endsWith('.' + d));
    if (domain) return `protected domain (${domain})`;
    const prefix = CONFIG.SKIP_HOST_PREFIXES.find((p) => host.startsWith(p));
    if (prefix) return `auth-like host (${prefix}…)`;
    const keyword = CONFIG.SKIP_HOST_KEYWORDS.find((k) => host.includes(k));
    if (keyword) return `banking-like host (contains "${keyword}")`;
    return null;
  }

  /** Check this frame's host and every ancestor frame's host (an auth page embedding us counts). */
  function pageSkipReason() {
    const hosts = [location.hostname];
    for (const origin of Array.from(location.ancestorOrigins || [])) {
      try { hosts.push(new URL(origin).hostname); } catch { /* ignore opaque origins */ }
    }
    for (const host of hosts) {
      const reason = hostSkipReason(host);
      if (reason) return reason;
    }
    if (CONFIG.SKIP_PATH_PATTERN.test(location.pathname)) return 'login/checkout/account path';
    return null;
  }

  /* ==========================================================================
   * DOM HELPERS
   * ======================================================================== */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    } else {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  /** Is the element (or an ancestor) position: fixed/sticky, i.e. floating over the page? */
  function isFloating(el) {
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const pos = getComputedStyle(node).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  /** Fraction of the viewport covered by the element (0..1). */
  function viewportCoverage(el) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return vw && vh ? (w * h) / (vw * vh) : 0;
  }

  const recentlyInteracted = (now) => now - lastUserInteractionAt < CONFIG.USER_INTERACTION_WINDOW_MS;

  /** Per-container bookkeeping: when it appeared and whether the user opened it. */
  function getInfo(el, now) {
    let info = containerInfo.get(el);
    if (!info) {
      info = { firstSeen: now, userInitiated: recentlyInteracted(now), clickedAt: 0 };
      containerInfo.set(el, info);
      if (info.userInitiated) {
        userModals.add(el);
        log('Ignoring user-opened dialog:', describe(el));
      }
    }
    return info;
  }

  function hasOpenUserModal() {
    for (const el of userModals) {
      if (!el.isConnected) userModals.delete(el);
      else if (isVisible(el)) return true;
    }
    return false;
  }

  /* ==========================================================================
   * CLICK SAFETY
   * ======================================================================== */

  /** A link that navigates somewhere (anything but "#" or javascript:). */
  function isRealLink(el) {
    const href = (el.getAttribute('href') || '').trim();
    return !!href && !href.startsWith('#') && !/^javascript:/i.test(href);
  }

  /** All the rules an element must pass before we click it. */
  function isSafeToClick(el, { allowHidden = false } = {}) {
    if (!el || clickedElements.has(el)) return false;
    if (!allowHidden && !isVisible(el)) return false;
    if (el.closest('[data-bs-closer-ignore]')) return false;

    // Never interact with login / payment forms.
    const form = el.closest('form');
    if (form && form.querySelector(SENSITIVE_INPUT_SELECTOR)) return false;

    // Never submit forms.
    if (el.tagName === 'INPUT' && el.type === 'submit') return false;
    if (el.tagName === 'BUTTON' && el.form && el.type === 'submit') return false;

    // Never follow real links (only "#" or javascript: pseudo-links are allowed).
    if (el.tagName === 'A' && isRealLink(el)) return false;

    // Never click purchase / subscribe / delete / account / confirm-style buttons.
    const fullLabel = normalize(labelSources(el).filter(Boolean).join(' ').slice(0, 300));
    if (DANGER_RE.test(fullLabel)) return false;

    return true;
  }

  /* ==========================================================================
   * ACTIONS
   * ======================================================================== */
  function registerAction() {
    actionCount++;
    lastActionAt = Date.now();
    if (actionCount >= CONFIG.MAX_ACTIONS_PER_PAGE) {
      stopped = true;
      if (observer) observer.disconnect();
      log(`Action budget (${CONFIG.MAX_ACTIONS_PER_PAGE}) reached — stopping on this page.`);
    }
  }

  function clickElement(el, reason) {
    clickedElements.add(el);
    log(`Click (${reason}):`, describe(el), el);
    registerAction();
    try {
      // Keep href="#" links from jumping the page to the top.
      if (el.tagName === 'A') el.addEventListener('click', (e) => e.preventDefault(), { once: true });
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (err) {
      log('Click failed:', err);
    }
  }

  /** Hide (not remove) an element — see styles.css for why. */
  function hideElement(el, reason) {
    if (!el || el.hasAttribute(HIDDEN_ATTR)) return false;
    el.setAttribute(HIDDEN_ATTR, reason);
    el.style.setProperty('display', 'none', 'important');
    log(`Hidden (${reason}):`, describe(el), el);
    registerAction();
    return true;
  }

  /* ==========================================================================
   * BUTTON FINDERS
   * ======================================================================== */

  /** First safe clickable inside `scope` whose label matches the keywords. Real controls are tried first. */
  function findByText(scope, keywords) {
    for (const selector of [PRIMARY_CLICKABLE, SECONDARY_CLICKABLE]) {
      for (const el of scope.querySelectorAll(selector)) {
        if (clickedElements.has(el)) continue;
        const match = matchLabel(el, keywords);
        if (match && isSafeToClick(el)) return { el, how: `text "${match}"` };
      }
    }
    return null;
  }

  /** Walk up from e.g. an <svg> icon to the button that owns it, staying inside `scope`. */
  function resolveClickable(el, scope) {
    const owner = el.closest(PRIMARY_CLICKABLE);
    return owner && scope.contains(owner) ? owner : el;
  }

  /** Close / dismiss button inside a popup: by text, then by attributes, then icon glyphs. */
  function findCloseButton(scope) {
    const byText = findByText(scope, KW.close);
    if (byText) return byText;

    for (const el of scope.querySelectorAll(CLOSE_SELECTOR)) {
      const target = resolveClickable(el, scope);
      if (clickedElements.has(target)) continue;
      if ((target.textContent || '').trim().length > CONFIG.MAX_LABEL_LENGTH) continue;
      if (isSafeToClick(target)) return { el: target, how: 'close selector' };
    }

    for (const el of scope.querySelectorAll(ALL_CLICKABLE)) {
      if (clickedElements.has(el)) continue;
      if (CLOSE_GLYPHS.has((el.textContent || '').trim().toLowerCase()) && isSafeToClick(el)) {
        return { el, how: 'close glyph' };
      }
    }
    return null;
  }

  /**
   * "OK" / "Got it" button of a notice banner: one where every control only acknowledges
   * it (text from ACKNOWLEDGE_KEYWORDS, or an × icon). Any other control, such as
   * Accept + Settings, means the banner offers a real choice, and null is returned.
   * Like everywhere else in consent banners, the × itself is never clicked.
   */
  function findAcknowledgeButton(banner) {
    const controls = new Set();
    for (const el of banner.querySelectorAll(ALL_CLICKABLE)) {
      if (!isVisible(el)) continue;
      const control = resolveClickable(el, banner);
      if (control.tagName === 'A' && isRealLink(control)) continue; // "Privacy policy" and similar links
      controls.add(control);
    }
    // Keep the innermost controls (drops e.g. a focusable <div> wrapped around the buttons).
    const buttons = [...controls].filter((c) => ![...controls].some((o) => o !== c && c.contains(o)));
    if (buttons.length > 4) return null;

    let target = null;
    for (const el of buttons) {
      const text = (el.textContent || '').trim();
      if (labelSources(el).some((src) => ACK_LABELS.has(normalize(src)))) target = target || el;
      else if (!(CLOSE_GLYPHS.has(text.toLowerCase()) || (!text && el.matches(CLOSE_SELECTOR)))) return null;
    }
    return target && isSafeToClick(target) ? { el: target, how: `text "${normalize(target.textContent)}"` } : null;
  }

  /* ==========================================================================
   * STEP 0 — DUCKDUCKGO AUTOCONSENT
   * DuckDuckGo's rule set (vendor/autoconsent, MPL-2.0) covers hundreds of
   * consent platforms, including multi-step opt-outs. It runs on its own
   * schedule; steps 1 and 3 hold off on consent banners while it is still
   * detecting or is opting out, and take over if it fails or finds nothing.
   * ======================================================================== */
  const AUTOCONSENT_DETECTING = new Set(['loading', 'initialized', 'started', 'cmpDetected']);
  const EVAL_EVENT = 'bs-closer:autoconsent-eval';
  const EVAL_RESULT_EVENT = 'bs-closer:autoconsent-eval-result';
  const autoconsent = { instance: null, lifecycle: '', busySince: 0, succeededAt: 0 };

  function startAutoconsent() {
    if (!CONFIG.AUTOCONSENT_ENABLED) return;
    const lib = globalThis.BSCloserAutoconsent;
    const rules = globalThis.BSCloserAutoconsentRules;
    if (!lib || !rules) {
      log('DuckDuckGo autoconsent files are missing; run scripts/update-autoconsent.mjs.');
      return;
    }
    try {
      // Configured after construction (as DuckDuckGo's standalone build does): passing the
      // config to the constructor initializes before the library's DOM helpers exist.
      autoconsent.instance = new lib.default(async (msg) => onAutoconsentMessage(msg));
      autoconsent.instance.initialize(
        {
          autoAction: 'optOut',
          heuristicMode: CONFIG.AUTOCONSENT_HEURISTIC_MODE,
          enableHeuristicDetection: CONFIG.AUTOCONSENT_HEURISTIC_MODE !== 'off',
          logs: { errors: false }, // errors arrive as messages and are logged below
        },
        { autoconsent: [], compact: lib.filterCompactRules(rules, { url: location.href, mainFrame: isTop }) },
      );
    } catch (err) {
      log('DuckDuckGo autoconsent failed to start:', err);
    }
  }

  function onAutoconsentMessage(msg) {
    switch (msg.type) {
      case 'eval': {
        const result = evalInPage(msg.id, msg.snippetId);
        // Reply asynchronously: the library registers the request only after sending it.
        Promise.resolve().then(() => autoconsent.instance.receiveMessageCallback({ type: 'evalResp', id: msg.id, result }));
        break;
      }
      case 'report':
        autoconsent.lifecycle = msg.state.lifecycle;
        break;
      case 'cmpDetected':
        log(`DuckDuckGo rules: ${msg.cmp} detected.`);
        break;
      case 'popupFound':
        autoconsent.busySince = Date.now();
        log(`DuckDuckGo rules: ${msg.cmp} banner found, opting out.`);
        break;
      case 'optOutResult':
        autoconsent.busySince = 0;
        if (msg.result) {
          autoconsent.succeededAt = lastActionAt = Date.now(); // lastActionAt lets restoreScroll run
          log(`DuckDuckGo rules: ${msg.cmp} opt-out succeeded.`);
        } else {
          log(`DuckDuckGo rules: ${msg.cmp} opt-out failed, BS Closer takes over.`);
        }
        scheduleScan();
        break;
      case 'autoconsentDone':
        log(`DuckDuckGo rules: ${msg.cmp} done (${msg.isCosmetic ? 'banner hidden' : `${msg.totalClicks} clicks`}, ${msg.duration} ms).`);
        break;
      case 'autoconsentError':
        log('DuckDuckGo rules error:', msg.details);
        break;
    }
  }

  /**
   * Run one of autoconsent's fixed snippets in the page's own world, where CMP APIs
   * live (see vendor/autoconsent/eval-bridge.js). DOM events are dispatched
   * synchronously across worlds, so the result is available on return.
   */
  function evalInPage(id, snippetId) {
    let result = false;
    const onResult = (e) => {
      try {
        const reply = JSON.parse(e.detail);
        if (reply.id === id) result = reply.result === true;
      } catch { /* not ours */ }
    };
    document.addEventListener(EVAL_RESULT_EVENT, onResult);
    document.dispatchEvent(new CustomEvent(EVAL_EVENT, { detail: JSON.stringify({ id, snippetId }) }));
    document.removeEventListener(EVAL_RESULT_EVENT, onResult);
    return result;
  }

  /** Should a consent banner first seen at `firstSeen` be left to autoconsent for now? */
  function waitForAutoconsent(firstSeen, now) {
    if (!autoconsent.instance) return false;
    if (autoconsent.busySince) return now - autoconsent.busySince < CONFIG.AUTOCONSENT_MAX_WAIT_MS;
    if (now - autoconsent.succeededAt < CONFIG.RETRY_DELAY_MS) return true; // give the banner time to close
    return AUTOCONSENT_DETECTING.has(autoconsent.lifecycle) && now - firstSeen < CONFIG.AUTOCONSENT_GRACE_MS;
  }

  /* ==========================================================================
   * STEP 1 — FRAMEWORK-SPECIFIC CONSENT HANDLING
   * ======================================================================== */
  function frameworkRoots(fw) {
    if (!fw.shadowHosts) return [document];
    return fw.shadowHosts
      .map((sel) => document.querySelector(sel)?.shadowRoot)
      .filter(Boolean);
  }

  function hideFramework(fw, reason) {
    for (const sel of fw.hide) {
      for (const el of document.querySelectorAll(sel)) hideElement(el, reason);
    }
  }

  function handleFrameworks(now) {
    for (const fw of FRAMEWORKS) {
      if (stopped) return;
      const state = frameworkState[fw.name] || (frameworkState[fw.name] = {});
      if (state.done) continue;

      const roots = frameworkRoots(fw);
      if (!roots.length) continue;
      const banners = roots.flatMap((r) => [...r.querySelectorAll(fw.banner)]).filter(isVisible);

      if (!banners.length) {
        if (state.clickedAt) {
          state.done = true;
          log(`${fw.name}: banner closed.`);
        }
        continue;
      }

      if (!state.firstSeen) {
        state.firstSeen = now;
        state.userInitiated = recentlyInteracted(now);
        log(`${fw.name} detected${state.userInitiated ? ' (opened by user — leaving it alone)' : ''}.`);
      }
      if (state.userInitiated) {
        state.done = true;
        continue;
      }

      // Already clicked: give the site a moment, then hide whatever is left.
      if (state.clickedAt) {
        if (now - state.clickedAt >= CONFIG.RETRY_DELAY_MS) {
          hideFramework(fw, `${fw.name} still visible after reject`);
          state.done = true;
        } else {
          needRecheck = true;
        }
        continue;
      }

      if (waitForAutoconsent(state.firstSeen, now)) {
        needRecheck = true;
        continue;
      }

      // a) Framework-specific reject selectors.
      let found = null;
      for (const root of roots) {
        for (const sel of fw.reject) {
          found = [...root.querySelectorAll(sel)]
            .find((el) => isSafeToClick(el, { allowHidden: fw.allowHidden }));
          if (found) break;
        }
        if (found) break;
      }
      let how = 'selector';

      // b) Fallback: text matching inside the visible banner(s).
      if (!found) {
        for (const banner of banners) {
          const match = findByText(banner, KW.reject);
          if (match) { found = match.el; how = match.how; break; }
        }
      }

      if (found) {
        clickElement(found, `${fw.name} reject via ${how}`);
        state.clickedAt = now;
        needRecheck = true;
        continue;
      }

      // c) No reject option (yet). Wait for buttons to render, then acknowledge a notice,
      //    accept (if enabled) or hide.
      if (now - state.firstSeen < CONFIG.HIDE_DELAY_MS) {
        needRecheck = true;
        continue;
      }
      if (CONFIG.ACKNOWLEDGE_NOTICE_BANNERS) {
        const ack = banners.map((b) => findAcknowledgeButton(b)).find(Boolean);
        if (ack) {
          clickElement(ack.el, `${fw.name} notice acknowledged via ${ack.how}`);
          state.clickedAt = now;
          needRecheck = true;
          continue;
        }
      }
      if (CONFIG.ACCEPT_AS_LAST_RESORT) {
        const accept = banners.map((b) => findByText(b, KW.accept)).find(Boolean);
        if (accept) {
          clickElement(accept.el, `${fw.name} accept (last resort) via ${accept.how}`);
          state.clickedAt = now;
          needRecheck = true;
          continue;
        }
      }
      hideFramework(fw, `${fw.name} has no reject option`);
      state.done = true;
    }
  }

  /* ==========================================================================
   * STEP 2 — KNOWN ANNOYANCE WIDGETS
   * ======================================================================== */
  function handleKnownAnnoyances() {
    for (const sel of CONFIG.KNOWN_DISMISS_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isSafeToClick(el)) clickElement(el, `known widget ${sel}`);
      }
    }
    for (const sel of CONFIG.KNOWN_HIDE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) hideElement(el, `known widget ${sel}`);
      }
    }
  }

  /* ==========================================================================
   * STEP 3 — GENERIC CONSENT BANNERS & POPUPS
   * ======================================================================== */

  /**
   * Classify a candidate element: { type: 'consent' | 'popup', floating } or null.
   * Ordered so the cheap checks run first.
   */
  function classifyContainer(el) {
    if (el === document.documentElement || el === document.body) return null;
    if (!isVisible(el)) return null;

    const floating = isFloating(el);
    const consentByAttr = el.matches(CONSENT_SELECTOR);
    if (!floating && !consentByAttr) return null;

    // Framework banners are handled in step 1 (which has its own text fallback).
    if (el.closest(FRAMEWORK_CONTAINER_SELECTOR) || el.querySelector(FRAMEWORK_CONTAINER_SELECTOR)) return null;
    if (el.matches(STRUCTURAL_SELECTOR) || el.querySelector(STRUCTURAL_SELECTOR)) return null;
    if (el.querySelector(SENSITIVE_INPUT_SELECTOR)) return null; // login / payment UI

    const text = el.textContent || '';
    const hasClickable = !!el.querySelector(ALL_CLICKABLE);
    const consentByText = CONSENT_TEXT_RE.test(normalize(text.slice(0, 2000)));

    if (consentByAttr || consentByText) {
      if (text.length > CONFIG.MAX_CONSENT_TEXT_LENGTH || !hasClickable) return null;
      // Non-floating consent blocks must actually talk about cookies (avoids "cookie settings" footer links etc.).
      if (!floating && !consentByText) return null;
      return { type: 'consent', floating };
    }

    if (!floating || text.length > CONFIG.MAX_POPUP_TEXT_LENGTH) return null;
    if (el.matches('header, nav') || el.closest('header, nav')) return null; // sticky site headers
    if (!hasClickable && viewportCoverage(el) < 0.5) return null; // buttons/launchers, not popups
    return { type: 'popup', floating };
  }

  /** Visible consent/popup containers, keeping only the outermost of nested matches. */
  function findContainers() {
    const kept = [];
    let checked = 0;
    for (const el of document.querySelectorAll(CONTAINER_SELECTOR)) {
      if (++checked > CONFIG.MAX_CANDIDATES_PER_SCAN) break;
      if (el.hasAttribute(HIDDEN_ATTR)) continue;
      if (kept.some((k) => k.el.contains(el))) continue;
      const result = classifyContainer(el);
      if (result) kept.push({ el, ...result });
    }
    return kept;
  }

  function handleConsent(el, floating, now) {
    const info = getInfo(el, now);
    if (info.userInitiated) return;

    if (info.clickedAt) {
      if (now - info.clickedAt < CONFIG.RETRY_DELAY_MS) needRecheck = true;
      else if (floating) hideElement(el, 'consent banner still visible after reject');
      return;
    }

    if (waitForAutoconsent(info.firstSeen, now)) {
      needRecheck = true;
      return;
    }

    const reject = findByText(el, KW.reject);
    if (reject) {
      clickElement(reject.el, `cookie reject via ${reject.how}`);
      info.clickedAt = now;
      needRecheck = true;
      return;
    }

    if (now - info.firstSeen < CONFIG.HIDE_DELAY_MS) {
      needRecheck = true;
      return;
    }
    if (CONFIG.ACKNOWLEDGE_NOTICE_BANNERS) {
      const ack = findAcknowledgeButton(el);
      if (ack) {
        clickElement(ack.el, `cookie notice acknowledged via ${ack.how}`);
        info.clickedAt = now;
        needRecheck = true;
        return;
      }
    }
    if (CONFIG.ACCEPT_AS_LAST_RESORT) {
      const accept = findByText(el, KW.accept);
      if (accept) {
        clickElement(accept.el, `cookie accept (last resort) via ${accept.how}`);
        info.clickedAt = now;
        needRecheck = true;
        return;
      }
    }
    // The banner's "X" may mean "accept" on some sites, so we hide instead of clicking it.
    if (floating) hideElement(el, 'consent banner without reject option');
  }

  function handlePopup(el, now) {
    const info = getInfo(el, now);
    if (info.userInitiated) return;

    if (info.clickedAt) {
      if (now - info.clickedAt < CONFIG.RETRY_DELAY_MS) needRecheck = true;
      else hideElement(el, 'popup still visible after close click');
      return;
    }

    const close = findCloseButton(el);
    if (close) {
      clickElement(close.el, `popup close via ${close.how}`);
      info.clickedAt = now;
      needRecheck = true;
      return;
    }

    if (now - info.firstSeen < CONFIG.HIDE_DELAY_MS) {
      needRecheck = true;
      return;
    }

    // No close button: hide only if it clearly is an annoyance.
    const text = normalize((el.textContent || '').slice(0, 3000));
    const coverage = viewportCoverage(el);
    if (ANNOYANCE_RE.test(text)) hideElement(el, 'annoyance popup');
    else if (coverage >= 0.6 && el.matches(MODAL_SELECTOR)) hideElement(el, 'full-screen modal');
    else if (actionCount > 0 && text.length < 3 && coverage >= 0.5) hideElement(el, 'leftover backdrop');
  }

  /* ==========================================================================
   * STEP 3b — HEURISTIC ANNOYANCES (top frame only)
   * Popups built with CSS-in-JS have no telling class names, so this step
   * finds floating elements by where they sit (a few elementsFromPoint probes,
   * plus fixed elements newly added to <body>) and scores them on how they
   * behave, using HEURISTIC_WEIGHTS. Runs after step 3 and skips anything it
   * or the consent logic handles. Scores are cached until the subtree mutates.
   * ======================================================================== */
  const heuristicOn = isTop && CONFIG.HEURISTIC_MODE !== 'off';
  const heuristicActs = CONFIG.HEURISTIC_MODE === 'act';
  const W = CONFIG.HEURISTIC_WEIGHTS;
  const INITIAL_WINDOW_MS = 1000; // seen this soon after start = part of the first snapshot (covers SPA hydration)
  const EDGE_PX = 24; // "docked" = this close to a viewport edge
  const SITE_CHROME_SELECTOR = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
  const EMAIL_INPUT_SELECTOR = 'input[type="email"], input[autocomplete="email"]';
  const MEDIA_SELECTOR = 'video[controls], audio[controls], [role="slider"], [class*="player" i]';
  const OTHER_INPUT_SELECTOR = [
    'input[type="search"]', '[role="search"]', 'input[name="q"]', 'input[name*="search" i]',
    'input[placeholder*="search" i]', 'input[placeholder*="buscar" i]', 'input[placeholder*="pesquis" i]',
    'input[type="password"]', 'input[autocomplete*="address"]', 'input[autocomplete="postal-code"]',
    'input[type="date"]', 'input[type="file"]',
  ].join(', ');
  const LIVE_REGION_SELECTOR = '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])';

  const heuristicInfo = new WeakMap(); // candidate → { firstSeen, initial, userInitiated, dirty, skip, score, signals, backdrop, loggedScore, clickedAt }
  const tracked = new Set(); // candidates on screen; a mutation inside one marks it for re-scoring
  const addedToBody = new Set(); // <body> children added since the last scan (portals)
  const heuristic = {
    startedAt: Date.now(), locked: false, lockedSince: 0,
    pastScrollMark: false, scrollTriggerAt: 0, exitIntentAt: 0, vendorOnPage: false, vendorCheckedAt: 0,
  };
  const actScore = (() => {
    const host = location.hostname.toLowerCase();
    const site = Object.keys(CONFIG.HEURISTIC_SITE_SCORES).find((d) => host === d || host.endsWith('.' + d));
    return site ? CONFIG.HEURISTIC_SITE_SCORES[site] : CONFIG.HEURISTIC_ACT_SCORE;
  })();

  /** MutationObserver hook: remember new <body> children and mark mutated candidates dirty. */
  function trackMutations(records) {
    for (const r of records) {
      if (r.target === document.body) {
        for (const n of r.addedNodes) if (n.nodeType === 1) addedToBody.add(n);
      }
      for (const el of tracked) {
        const info = heuristicInfo.get(el);
        if (!info.dirty && el.contains(r.target)) info.dirty = true;
      }
    }
  }

  function onScrollDepth() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const past = max > 0 && window.scrollY / max >= 0.4;
    if (past && !heuristic.pastScrollMark) heuristic.scrollTriggerAt = Date.now();
    heuristic.pastScrollMark = past;
  }

  function onMouseOut(e) {
    if (!e.relatedTarget && e.clientY <= 0) heuristic.exitIntentAt = Date.now(); // pointer left through the top
  }

  function updateScrollLock(now) {
    const locked = [document.documentElement, document.body].some((el) => {
      if (!el) return false;
      if ([...el.classList].some((c) => SCROLL_LOCK_CLASSES.has(c.toLowerCase()))) return true;
      const s = getComputedStyle(el);
      return s.overflowY === 'hidden' || s.overflowY === 'clip' || (el === document.body && s.position === 'fixed');
    });
    if (locked === heuristic.locked) return;
    heuristic.locked = locked;
    if (locked) heuristic.lockedSince = now;
    for (const el of tracked) heuristicInfo.get(el).dirty = true;
  }

  function isFloatingRoot(el) {
    const s = getComputedStyle(el);
    return s.position === 'fixed' || (s.position === 'sticky' && parseInt(s.zIndex, 10) >= 100);
  }

  /** Outermost fixed (or high-z sticky) ancestor of `node` below <body>, memoised per scan in `roots`. */
  function floatingRootOf(node, roots) {
    const chain = [];
    let n = node;
    for (; n && n !== document.body && n !== document.documentElement && !roots.has(n); n = n.parentElement) chain.push(n);
    let root = n && roots.has(n) ? roots.get(n) : null;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!root && isFloatingRoot(chain[i])) root = chain[i];
      roots.set(chain[i], root);
    }
    return roots.get(node) || null;
  }

  /** Floating elements at a few key viewport points, plus floating portals added to <body>. */
  function findHeuristicCandidates() {
    const found = new Set();
    const roots = new Map();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const points = [[vw / 2, vh / 2], [vw / 2, vh - 30], [vw - 30, vh - 30], [vw / 2, 30], [30, vh / 2]];
    for (const [x, y] of points) {
      for (const hit of document.elementsFromPoint(x, y).slice(0, 6)) {
        const root = floatingRootOf(hit, roots);
        if (root) found.add(root);
      }
    }
    for (const node of addedToBody) {
      if (!node.isConnected) continue;
      if (isFloatingRoot(node)) found.add(node);
      else for (const child of [...node.children].slice(0, 5)) if (isFloatingRoot(child)) found.add(child);
    }
    addedToBody.clear();
    return found;
  }

  /** Already handled (or protected) by another part of BS Closer, or by the user. */
  function handledElsewhere(el, containers) {
    if (el.closest(`[${HIDDEN_ATTR}], [data-bs-closer-ignore]`) || el.querySelector(`[${HIDDEN_ATTR}]`)) return true;
    if (containerInfo.has(el) || containers.some((c) => c.el.contains(el) || el.contains(c.el))) return true;
    if (el.closest(FRAMEWORK_CONTAINER_SELECTOR) || el.querySelector(FRAMEWORK_CONTAINER_SELECTOR)) return true;
    for (const m of userModals) if (m.contains(el) || el.contains(m)) return true;
    return false;
  }

  /** Never a heuristic target: login/payment UI, consent banners, or nothing to see (a bare backdrop). */
  function notAnAnnoyance(el, text) {
    if (el.querySelector(SENSITIVE_INPUT_SELECTOR)) return true;
    if (el.matches(CONSENT_SELECTOR)) return true;
    if (CONSENT_TEXT_RE.test(normalize(text.slice(0, 2000))) && !el.querySelector(EMAIL_INPUT_SELECTOR)) return true;
    return !text.trim() && !el.querySelector('iframe, img, svg, video');
  }

  /** The visible box of a popup: the element, or for a full-screen wrapper the first box inside it. */
  function layoutBox(el) {
    if (viewportCoverage(el) < 0.9) return el;
    let checked = 0;
    for (const child of el.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *')) {
      if (++checked > 30) break;
      const c = viewportCoverage(child);
      if (c > 0.02 && c < 0.9 && isVisible(child)) return child;
    }
    return el;
  }

  function isBackdrop(el) {
    if (viewportCoverage(el) < 0.9) return false;
    const s = getComputedStyle(el);
    const rgba = s.backgroundColor.match(/[\d.]+/g) || [];
    const alpha = rgba.length >= 4 ? Number(rgba[3]) : rgba.length === 3 ? 1 : 0;
    return (alpha > 0 && (alpha < 1 || Number(s.opacity) < 1)) || (s.backdropFilter || 'none') !== 'none';
  }

  /** Semi-transparent full-viewport backdrop: a sibling, the element itself, or a direct child. */
  function findBackdrop(el) {
    for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
      if (sib && !sib.hasAttribute(HIDDEN_ATTR) && isVisible(sib) && isBackdrop(sib)) return sib;
    }
    if (isBackdrop(el)) return el;
    return [...el.children].slice(0, 5).find((c) => isVisible(c) && isBackdrop(c)) || null;
  }

  function isVendorUrl(url) {
    try {
      const host = new URL(url, location.href).hostname;
      return CONFIG.POPUP_VENDOR_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    } catch {
      return false;
    }
  }

  const hasVendorSource = (scope) => [...scope.querySelectorAll('script[src], iframe[src]')].some((n) => isVendorUrl(n.src));

  /** Vendor scripts load late, so the page is re-checked every few seconds until one shows up. */
  function vendorOnPage(now) {
    if (!heuristic.vendorOnPage && now - heuristic.vendorCheckedAt >= 5000) {
      heuristic.vendorCheckedAt = now;
      heuristic.vendorOnPage = hasVendorSource(document);
    }
    return heuristic.vendorOnPage;
  }

  function scoreCandidate(el, info, text, now) {
    const signals = [];
    const add = (name, fired) => { if (fired && W[name]) signals.push([name, W[name]]); };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const box = layoutBox(el);
    const r = box.getBoundingClientRect();
    const coverage = viewportCoverage(box);
    const atTop = r.top <= EDGE_PX;
    const atBottom = r.bottom >= vh - EDGE_PX;
    const inCorner = coverage < 0.25 && (r.left <= 60 || r.right >= vw - 60) && (r.top <= 60 || r.bottom >= vh - 60);
    const centred = coverage >= 0.15 && coverage <= 0.8
      && Math.abs((r.left + r.right) / 2 - vw / 2) < vw * 0.1 && Math.abs((r.top + r.bottom) / 2 - vh / 2) < vh * 0.2;
    // Bars docked to the top count only when they appear late: at load they're usually site chrome.
    const docked = coverage < 0.5 && (atBottom || inCorner || (atTop && !info.initial));
    const soonAfter = (at) => at > 0 && info.firstSeen - at >= 0 && info.firstSeen - at <= CONFIG.HEURISTIC_TRIGGER_WINDOW_MS;
    const age = info.firstSeen - heuristic.startedAt;

    add('late', !info.initial);
    add('trigger', (age >= 3000 && age <= 30000) || soonAfter(heuristic.scrollTriggerAt) || soonAfter(heuristic.exitIntentAt));
    info.backdrop = findBackdrop(el);
    add('backdrop', !!info.backdrop);
    add('scrollLock', heuristic.locked && Math.abs(heuristic.lockedSince - info.firstSeen) <= CONFIG.HEURISTIC_TRIGGER_WINDOW_MS);
    add('zIndex', parseInt(getComputedStyle(el).zIndex, 10) >= 1000);
    add('placement', centred || docked);
    add('emailInput', !!el.querySelector(EMAIL_INPUT_SELECTOR));
    add('closeButton', !!findCloseButton(el));
    add('annoyanceText', ANNOYANCE_RE.test(normalize(text.slice(0, 3000))));
    const vendorInside = hasVendorSource(el);
    add('vendor', vendorInside);
    add('vendorOnPage', !vendorInside && vendorOnPage(now));
    add('siteChrome', !!(el.closest(SITE_CHROME_SELECTOR) || el.querySelector(SITE_CHROME_SELECTOR)));
    add('content', el.querySelectorAll('a[href]').length > 8 || text.trim().length > 600);
    add('media', !!el.querySelector(MEDIA_SELECTOR));
    add('otherInputs', !!el.querySelector(OTHER_INPUT_SELECTOR));
    add('initialTopBar', info.initial && atTop && coverage < 0.5);
    add('liveRegion', el.matches(LIVE_REGION_SELECTOR) || !!el.querySelector(LIVE_REGION_SELECTOR));

    info.signals = signals;
    info.score = signals.reduce((sum, [, w]) => sum + w, 0);
  }

  /** One line per candidate (again only if its score changes), with the signals that fired. */
  function logCandidate(el, info) {
    info.loggedScore = info.score;
    if (heuristicActs && info.score < CONFIG.HEURISTIC_LOG_SCORE) return;
    const verdict = info.score >= actScore ? (heuristicActs ? 'Heuristic match' : 'Heuristic would close')
      : info.score >= CONFIG.HEURISTIC_LOG_SCORE ? 'Heuristic suspect' : 'Heuristic ignored';
    const signals = info.signals.map(([name, w]) => `${w > 0 ? '+' : '−'}${Math.abs(w)} ${name}`).join(' ');
    log(`${verdict} (score ${info.score}): ${describe(el)}\n    ${signals || 'no signals'}`, el);
  }

  function hideCandidate(el, info, reason) {
    hideElement(el, reason);
    if (info.backdrop && !el.contains(info.backdrop)) hideElement(info.backdrop, 'heuristic backdrop');
    tracked.delete(el);
  }

  function handleHeuristic(now, containers) {
    const t0 = performance.now();
    const initialPass = now - heuristic.startedAt < INITIAL_WINDOW_MS;
    updateScrollLock(now);

    const candidates = findHeuristicCandidates();
    for (const el of tracked) candidates.add(el);
    for (const el of candidates) {
      if (stopped) break;
      if (el === document.body || !isVisible(el) || handledElsewhere(el, containers)) {
        tracked.delete(el);
        continue;
      }

      let info = heuristicInfo.get(el);
      if (!info) {
        info = { firstSeen: now, initial: initialPass, userInitiated: recentlyInteracted(now), dirty: true, loggedScore: null, clickedAt: 0 };
        heuristicInfo.set(el, info);
        if (info.userInitiated) {
          userModals.add(el);
          log('Ignoring user-opened dialog:', describe(el));
        }
      }
      if (info.userInitiated) continue;
      tracked.add(el);

      if (info.clickedAt) {
        if (now - info.clickedAt < CONFIG.RETRY_DELAY_MS) needRecheck = true;
        else hideCandidate(el, info, 'heuristic popup still visible after close click');
        continue;
      }

      if (info.dirty) {
        info.dirty = false;
        const text = el.innerText || '';
        info.skip = notAnAnnoyance(el, text);
        if (!info.skip) scoreCandidate(el, info, text, now);
      }
      if (info.skip) continue;
      if (info.score !== info.loggedScore) logCandidate(el, info);
      if (!heuristicActs || info.score < actScore) continue;

      const close = findCloseButton(el);
      if (close) {
        clickElement(close.el, `heuristic close via ${close.how}, score ${info.score}`);
        if (info.backdrop && !el.contains(info.backdrop)) hideElement(info.backdrop, 'heuristic backdrop');
        info.clickedAt = now;
        needRecheck = true;
      } else if (now - info.firstSeen < CONFIG.HIDE_DELAY_MS) {
        needRecheck = true; // let its buttons render first
      } else {
        hideCandidate(el, info, `heuristic annoyance, score ${info.score}`);
      }
    }

    // Budget: under 2 ms per pass once warm (DevTools → Performance → Timings).
    if (CONFIG.DEBUG) performance.measure('bs-closer heuristic', { start: t0, end: performance.now() });
  }

  /* ==========================================================================
   * STEP 4 — RESTORE SCROLLING
   * ======================================================================== */
  function restoreScroll(now) {
    if (!isTop || !lastActionAt || now - lastActionAt > CONFIG.SCROLL_RESTORE_WINDOW_MS) return;
    if (hasOpenUserModal()) return; // the user opened a dialog — its scroll lock is legitimate

    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;

      const lockClasses = [...el.classList].filter((c) => SCROLL_LOCK_CLASSES.has(c.toLowerCase()));
      if (lockClasses.length) {
        el.classList.remove(...lockClasses);
        log(`Removed scroll-lock classes from <${el.tagName.toLowerCase()}>:`, lockClasses.join(', '));
      }

      const style = getComputedStyle(el);
      if ((style.overflowY === 'hidden' || style.overflowY === 'clip') && !el.hasAttribute(SCROLL_ATTR)) {
        el.setAttribute(SCROLL_ATTR, '');
        log(`Restored scrolling on <${el.tagName.toLowerCase()}>.`);
      }

      // "position: fixed; top: -1234px" lock: unfix and jump back to where the user was.
      if (el === document.body && style.position === 'fixed' && !el.hasAttribute(UNFIXED_ATTR)) {
        const offset = parseInt(el.style.top, 10) || 0;
        el.setAttribute(UNFIXED_ATTR, '');
        el.style.removeProperty('top');
        if (offset < 0) window.scrollTo(0, -offset);
        log('Removed position:fixed scroll lock from <body>.');
      }
    }
  }

  /* ==========================================================================
   * SCAN LOOP
   * ======================================================================== */
  function runScan() {
    if (stopped) return;
    const now = Date.now();
    lastScanAt = now;
    needRecheck = false;

    // SPA navigation can land on a login/checkout route after load.
    if (CONFIG.SKIP_PATH_PATTERN.test(location.pathname)) return;

    try {
      handleFrameworks(now);
      if (isTop && !stopped) handleKnownAnnoyances();
      const containers = findContainers();
      for (const { el, type, floating } of containers) {
        if (stopped) break;
        if (type === 'consent') handleConsent(el, floating, now);
        else if (isTop) handlePopup(el, now); // popups in iframes are usually ads/widgets we can't judge
      }
      if (heuristicOn && !stopped) handleHeuristic(now, containers);
      restoreScroll(now);
    } catch (err) {
      log('Scan error:', err);
    }

    if (needRecheck && !stopped) scheduleScan(CONFIG.RECHECK_DELAY_MS);
  }

  /** Throttled scheduling: at most one scan per MIN_SCAN_INTERVAL_MS, run when the browser is idle. */
  function scheduleScan(delay = 0) {
    if (stopped || scanTimer) return;
    const wait = Math.max(delay, CONFIG.MIN_SCAN_INTERVAL_MS - (Date.now() - lastScanAt));
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (document.hidden) return; // resumes on visibilitychange
      if ('requestIdleCallback' in window) requestIdleCallback(runScan, { timeout: 1000 });
      else runScan();
    }, wait);
  }

  /* ==========================================================================
   * INIT
   * ======================================================================== */
  const skipReason = pageSkipReason();
  if (skipReason) {
    if (isTop) log(`Disabled on this page: ${skipReason}.`);
    return;
  }
  if (isTop) log('Active.');
  if (heuristicOn && actScore !== CONFIG.HEURISTIC_ACT_SCORE) log(`Heuristic act score for this site: ${actScore}.`);
  startAutoconsent();

  // Track genuine user interaction so dialogs the user opens are left alone.
  // Programmatic clicks (including ours) have isTrusted === false.
  const markInteraction = (e) => { if (e.isTrusted) lastUserInteractionAt = Date.now(); };
  window.addEventListener('pointerdown', markInteraction, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === ' ' && e.target !== document.body)) markInteraction(e);
  }, true);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });

  // Popup triggers the heuristic looks for: scrolling past ~40 % and exit intent.
  if (heuristicOn) {
    window.addEventListener('scroll', onScrollDepth, { passive: true });
    document.addEventListener('mouseout', onMouseOut, true);
  }

  observer = new MutationObserver((records) => {
    if (heuristicOn) trackMutations(records);
    scheduleScan();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
  });

  runScan();
})();

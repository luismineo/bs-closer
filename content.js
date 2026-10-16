/**
 * BS Closer — content script
 *
 * Runs on every page (and every frame) and:
 *   1. Rejects cookie consent via framework-specific selectors (OneTrust,
 *      Cookiebot, Usercentrics, TrustArc, Didomi), falling back to text matching.
 *   2. Dismisses newsletter / survey / marketing / app-download / notification
 *      popups by clicking their close or "no thanks" buttons.
 *   3. Hides leftover overlays and restores page scrolling.
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

    MIN_SCAN_INTERVAL_MS: 700, // throttle between DOM scans
    RECHECK_DELAY_MS: 800, // follow-up scan while waiting on a banner
    HIDE_DELAY_MS: 1500, // a container must be visible this long before we hide it (lets buttons render)
    RETRY_DELAY_MS: 1500, // after a click, wait this long before hiding a container that is still visible
    USER_INTERACTION_WINDOW_MS: 2000, // popups appearing this soon after a user click are user-initiated → left alone
    SCROLL_RESTORE_WINDOW_MS: 10000, // only restore scrolling shortly after we acted
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
      'coupon', 'promo code', '% off', 'off your first', 'offer', 'deal', 'survey', 'feedback',
      'quick question', 'download the app', 'get the app', 'open in app', 'open the app',
      'use the app', 'app store', 'google play', 'notifications', 'push notifications',
      'allow notifications', 'stay updated', 'stay in the loop', 'join our', 'join now',
      'chat with us', 'how can we help', 'can we help', 'need help', 'cookie', 'cookies', 'consent',
      // Português (BR)
      'inscreva se', 'inscreva', 'assine', 'cadastre se', 'cadastre', 'receba', 'ofertas', 'oferta',
      'desconto', 'cupom', 'promoção', 'pesquisa', 'avalie', 'sua opinião', 'baixe o app',
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
    if (el.tagName === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) return false;
    }

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

      // c) No reject option (yet). Wait for buttons to render, then accept (if enabled) or hide.
      if (now - state.firstSeen < CONFIG.HIDE_DELAY_MS) {
        needRecheck = true;
        continue;
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
      for (const { el, type, floating } of findContainers()) {
        if (stopped) break;
        if (type === 'consent') handleConsent(el, floating, now);
        else if (isTop) handlePopup(el, now); // popups in iframes are usually ads/widgets we can't judge
      }
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

  // Track genuine user interaction so dialogs the user opens are left alone.
  // Programmatic clicks (including ours) have isTrusted === false.
  const markInteraction = (e) => { if (e.isTrusted) lastUserInteractionAt = Date.now(); };
  window.addEventListener('pointerdown', markInteraction, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === ' ' && e.target !== document.body)) markInteraction(e);
  }, true);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });

  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
  });

  runScan();
})();

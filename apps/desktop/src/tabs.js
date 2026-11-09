// Embedded Chromium tabs (one WebContentsView per tab) inside the main window.
const { EventEmitter } = require('node:events');
const { WebContentsView, session, shell } = require('electron');
const { HOME_URL, PARTITION, chromeUserAgent } = require('./config');
const { heavyTabs } = require('./tab-memory');
const { t, getLang } = require('./i18n');
const path = require('node:path');

const PAGE_RADIUS = 13;

const ALLOWED_SCHEMES = /^(https?:|about:blank)/i;
const GOOGLE_SIGNIN = /^https:\/\/accounts\.google\.com\/(v\d\/)?(signin|ServiceLogin|AccountChooser|InteractiveLogin)/i;

/** Turns address-bar input into a URL: keeps http(s), adds https:// to domains, otherwise searches. */
function normalizeInput(input, settings) {
  const text = String(input || '').trim();
  if (!text) return settings?.get('general.homeUrl') || HOME_URL;
  if (/^https?:\/\//i.test(text) || text === 'about:blank') return text;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text) || /^localhost(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
  return settings ? settings.searchUrl(text) : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

// Browser permissions a site may get without asking. Everything else (camera, mic,
// geolocation, notifications, MIDI, USB, ...) is denied: the runtime would otherwise grant all.
const GRANTED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management']);

function hardenSession(ses) {
  ses.setUserAgent(chromeUserAgent());
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(GRANTED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => GRANTED_PERMISSIONS.has(permission));
}

class TabManager extends EventEmitter {
  constructor(win, { onShortcut, settings } = {}) {
    super();
    this.settings = settings; // home page and search engine (설정 > 일반)
    this.win = win;
    this.onShortcut = onShortcut || (() => {});
    this.tabs = new Map(); // id -> { id, view, favicon }
    this.activeId = null;
    this.nextId = 1;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.hidden = false; // true while the user drags a panel divider (the view would swallow the mouse)
    hardenSession(session.fromPartition(PARTITION));
    // A tab opened while the window is minimized or in the tray never gets a size (0×0 viewport),
    // so the agent could not click or type in it. Re-lay out when the window changes state.
    for (const ev of ['minimize', 'restore', 'hide', 'show']) win?.on?.(ev, () => this.layout());
  }

  /** True while the window is minimized or hidden (tray): new pages get no size from it then. */
  offscreen() {
    try {
      return !!this.win && (this.win.isMinimized() || !this.win.isVisible());
    } catch {
      return false;
    }
  }

  /**
   * Gives a page the page area's size while the window cannot (see constructor). A page keeps
   * that size until it is on screen: a background tab opened while minimized has no other size.
   */
  fixViewport(tab) {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const { width, height } = this.bounds;
    const onScreen = !this.offscreen() && tab.id === this.activeId && !this.hidden;
    if (tab.emulated && onScreen) {
      wc.disableDeviceEmulation();
      tab.emulated = null;
    } else if ((this.offscreen() || tab.emulated) && !onScreen && width > 0 && height > 0) {
      const key = `${width}x${height}`;
      if (tab.emulated === key) return;
      wc.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width, height }, scale: 1 });
      tab.emulated = key;
    }
  }

  /** A tab showing the live picture of the Chromium session (google-browser.js). */
  createMirror() {
    const tab = this.create('about:blank', true);
    tab.mirror = { title: t('Google 세션 화면'), url: '' };
    tab.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'mirror.html'), { query: { lang: getLang() } }).catch(() => {});
    tab.view.webContents.on('did-navigate-in-page', (_e, url) => url.endsWith('#window') && this.emit('mirror-window'));
    this.mirror = tab;
    return tab;
  }

  mirrorPage({ title, url }) {
    if (!this.mirror) return;
    Object.assign(this.mirror.mirror, { title: title || url || t('Google 세션 화면'), url });
    this.changed();
  }

  mirrorFrame(data) {
    const wc = this.mirror?.view.webContents;
    if (!wc || wc.isDestroyed() || this.mirrorBusy) return;
    this.mirrorBusy = true;
    wc.executeJavaScript(`show("${data}")`).catch(() => {}).finally(() => (this.mirrorBusy = false));
  }

  info(tab) {
    const wc = tab.view.webContents;
    if (tab.mirror) return { id: tab.id, title: tab.mirror.title, url: tab.mirror.url, loading: false, favicon: null, canGoBack: false, canGoForward: false };
    return {
      id: tab.id,
      title: wc.getTitle() || t('새 탭'),
      url: wc.getURL(),
      loading: wc.isLoading(),
      favicon: tab.favicon || null,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  list() {
    return [...this.tabs.values()].map((tab) => this.info(tab));
  }

  /** Reloads the tabs over the memory limit; returns their addresses. */
  reloadHeavy(metrics, limitMb) {
    const heavy = heavyTabs([...this.tabs.values()], metrics, limitMb);
    for (const t of heavy) t.view.webContents.reload();
    return heavy.map((t) => t.view.webContents.getURL());
  }

  changed() {
    this.emit('change', { tabs: this.list(), activeTabId: this.activeId });
  }

  setBounds(b) {
    this.bounds = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height)),
    };
    this.layout();
  }

  /** The page view is a native layer over the UI: hide it while the UI needs that area. */
  setHidden(hidden, reason = 'resize') {
    this.hiddenBy = this.hiddenBy || new Set();
    if (hidden) this.hiddenBy.add(reason);
    else this.hiddenBy.delete(reason);
    this.hidden = this.hiddenBy.size > 0;
    this.layout();
  }

  layout() {
    for (const t of this.tabs.values()) {
      const visible = t.id === this.activeId && !this.hidden;
      t.view.setVisible(visible);
      // Hidden tabs keep the page area's size too: a background tab (a sub-agent's) must lay out
      // like a real window, or it has no viewport to read.
      if (this.bounds) t.view.setBounds(this.bounds);
      this.fixViewport(t);
    }
  }

  create(url, activate = true) {
    url = url || this.settings?.get('general.homeUrl') || HOME_URL;
    const view = new WebContentsView({
      // backgroundThrottling off: pages keep rendering while ANB is minimized or covered, so the
      // agent's screenshots and timers don't stall (a stalled page made page.screenshot time out).
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    view.setBackgroundColor('#ffffff');
    view.setBorderRadius?.(PAGE_RADIUS); // matches the browser card's inner corners (ui/styles.css)
    const tab = { id: this.nextId++, view, favicon: null };
    this.tabs.set(tab.id, tab);
    this.win.contentView.addChildView(view);

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: target }) => {
      // Google's popups ("verify it's you", "Sign in with Google"): the page stays and the app
      // decides where they continue. A tab would only be left blank.
      if (/^https:\/\/accounts\.google\.com\//i.test(target)) this.loginNeeded(tab.id, target, true);
      else if (ALLOWED_SCHEMES.test(target)) this.create(target, true); // popups/target=_blank become tabs
      else if (/^mailto:|^tel:/i.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    // Block navigations to local files, chrome://, javascript: etc.
    wc.on('will-navigate', (e, target) => {
      if (!ALLOWED_SCHEMES.test(target)) e.preventDefault();
    });
    // Google refuses sign-in inside embedded browsers (a deliberate security policy), so tabs never
    // open Google's sign-in pages: the navigation is stopped and the agent panel offers a
    // "Google 로그인" button instead (main.js + google-login.js); afterwards the tab opens the page.
    const signin = (target) => {
      if (!GOOGLE_SIGNIN.test(target)) return false;
      this.loginNeeded(tab.id, target);
      return true;
    };
    wc.on('will-navigate', (e, target) => signin(target) && e.preventDefault());
    wc.on('will-redirect', (e, target) => signin(target) && e.preventDefault());
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !signin(details.url)) return; // loadURL / automation
      // Stopping inside this event tears down the navigation while it is starting and crashes the app.
      setImmediate(() => wc.isDestroyed() || wc.stop());
    });
    wc.on('did-navigate', (_e, target) => {
      if (!signin(target)) return;
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else wc.loadURL('about:blank').catch(() => {});
    });
    // A security service's check that the embedded browser cannot finish: the app offers the real one.
    wc.on('page-title-updated', (_e, title) => {
      if (/^(잠시만 기다리십시오|just a moment)/i.test(title)) this.emit('human-check', { tabId: tab.id, url: wc.getURL() });
    });
    // A navigation can swap the page into another renderer, which drops the size given while
    // the window is minimized: give it again.
    wc.on('did-navigate', () => {
      if (tab.emulated) tab.emulated = 'stale';
      this.fixViewport(tab);
    });
    const update = () => this.changed();
    for (const ev of ['page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, update);
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons.find((f) => /^https:/i.test(f)) || null;
      update();
    });
    wc.on('before-input-event', (_e, input) => this.onShortcut(input));
    const first = normalizeInput(url, this.settings);
    if (GOOGLE_SIGNIN.test(first)) {
      this.loginNeeded(tab.id, first);
      wc.loadURL('about:blank').catch(() => {});
    } else wc.loadURL(first).catch(() => {});

    if (activate) this.activate(tab.id);
    else this.layout();
    this.changed();
    return tab;
  }

  activate(id) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;
    this.layout();
    this.changed();
  }

  close(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    this.win.contentView.removeChildView(t.view);
    t.view.webContents.close();
    this.tabs.delete(id);
    if (this.mirror === t) {
      this.mirror = null;
      this.emit('mirror-closed');
    }
    this.emit('closed', t.view.webContents);
    if (this.activeId === id) {
      const rest = [...this.tabs.keys()];
      this.activeId = rest.length ? rest[rest.length - 1] : null;
    }
    if (!this.tabs.size) this.create(undefined, true);
    this.layout();
    this.changed();
  }

  active() {
    return this.tabs.get(this.activeId) || null;
  }

  activeWebContents() {
    return this.active()?.view.webContents || null;
  }

  go(input) {
    const target = normalizeInput(input, this.settings);
    if (GOOGLE_SIGNIN.test(target) && this.activeId) return this.loginNeeded(this.activeId, target);
    if (this.active()?.mirror) return this.create(target, true);
    this.activeWebContents()?.loadURL(target).catch(() => {});
  }

  /** A tab wanted Google's sign-in: tell the app once per burst (Google chains several URLs). */
  loginNeeded(tabId, url, popup = false) {
    const now = Date.now();
    if (this.lastLogin && this.lastLogin.tabId === tabId && now - this.lastLogin.at < 5000) return;
    this.lastLogin = { tabId, at: now };
    this.emit('login-blocked', { tabId, url, popup, service: 'Google' });
  }
}

module.exports = { GOOGLE_SIGNIN, TabManager, normalizeInput, ALLOWED_SCHEMES };

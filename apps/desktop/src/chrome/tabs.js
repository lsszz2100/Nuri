// Tabs of the real Chrome window (ChromeEngine), with the same interface as the built-in
// TabManager, so the agent, the IPC handlers and the UI's tab strip work on either engine.
// Each tab gets a small "handle" that stands in for a tab's webContents.

const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { normalizeInput } = require('../tabs');
const { t } = require('../i18n');

// Only web pages are tabs: the agent side panel, extension pages and chrome:// UI are not.
const isWebUrl = (u) => !/^(chrome-extension|chrome|chrome-error|devtools|edge|chrome-untrusted):/i.test(String(u || ''));

class ChromeTabs extends EventEmitter {
  /**
   * @param {{engine: import('./engine').ChromeEngine, settings: any, log: Function, downloads?: any}} deps
   */
  constructor({ engine, settings, log, downloads }) {
    super();
    this.engine = engine;
    this.settings = settings;
    this.log = log || (() => {});
    this.downloads = downloads;
    this.isChrome = true;
    this.tabs = new Map(); // id -> { id, page, handle, title, url }
    this.byPage = new Map(); // Page -> id
    this.nextId = 1;
    this.activeId = null;
    this.stagingDir = path.join(os.tmpdir(), 'anb-chrome-downloads');
    engine.on('connected', (browser) => this.attach(browser).catch((e) => this.log('chrome attach failed', e.message)));
    engine.on('closed', () => this.reset());
    engine.on('disconnected', () => this.reset());
  }

  reset() {
    this.tabs.clear();
    this.byPage.clear();
    this.activeId = null;
    this.changed();
  }

  async attach(browser) {
    const ctx = browser.contexts()[0];
    if (!ctx) return;
    for (const page of ctx.pages()) this.register(page);
    ctx.on('page', (page) => {
      const id = this.register(page);
      if (id) this.activeId = id; // a new tab (link with target=_blank, window.open) comes to the front
      this.changed();
    });
    // Downloads go to a staging folder first, then to the folder from 설정 / the autopilot project.
    this.cdp = await browser.newBrowserCDPSession();
    await this.applyDownloads();
    this.cdp.on('Browser.downloadWillBegin', (e) => this.downloads?.chromeBegin(e));
    this.cdp.on('Browser.downloadProgress', (e) => this.downloads?.chromeProgress(e, this.stagingDir));
    this.changed();
  }

  async applyDownloads() {
    if (!this.cdp) return;
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.stagingDir, eventsEnabled: true }).catch((e) => this.log('download behavior', e.message));
  }

  register(page) {
    if (this.byPage.has(page)) return this.byPage.get(page);
    if (!isWebUrl(page.url())) return null;
    const id = this.nextId++;
    const handle = {
      id,
      page,
      isDestroyed: () => page.isClosed(),
      isLoading: () => false,
      getURL: () => (page.isClosed() ? '' : page.url()),
      getTitle: () => this.tabs.get(id)?.title || '',
      reload: () => page.reload().catch(() => {}),
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => true,
        goBack: () => page.goBack().catch(() => {}),
        goForward: () => page.goForward().catch(() => {}),
      },
    };
    const entry = { id, page, handle, title: '', url: page.url() };
    this.tabs.set(id, entry);
    this.byPage.set(page, id);
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('close', () => {
      this.tabs.delete(id);
      this.byPage.delete(page);
      if (this.activeId === id) this.activeId = [...this.tabs.keys()].pop() ?? null;
      this.changed();
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      entry.url = page.url();
      page.title().then((t) => {
        entry.title = t;
        this.changed();
      }, () => {});
    });
    page.title().then((t) => (entry.title = t), () => {});
    return id;
  }

  /** Reads which tab is in front (the visible one; the focused window wins). */
  async refresh() {
    await this.engine.connect();
    const ctx = this.engine.context();
    if (ctx) for (const page of ctx.pages()) this.register(page);
    let best = null;
    for (const entry of this.tabs.values()) {
      if (!isWebUrl(entry.page.url())) continue;
      const s = await entry.page.evaluate(() => ({ v: document.visibilityState === 'visible', f: document.hasFocus() })).catch(() => null);
      if (!s?.v) continue;
      if (!best || (s.f && !best.f)) best = { id: entry.id, f: s.f };
    }
    if (best) this.activeId = best.id;
    else if (!this.tabs.has(this.activeId)) this.activeId = [...this.tabs.keys()].pop() ?? null;
    return this.activeId;
  }

  /** For the agent: the tab in front as { wc: handle, page }. Opens Chrome / a tab when needed. */
  async activePage() {
    await this.refresh();
    if (!this.activeId) await this.create(undefined, true);
    const entry = this.tabs.get(this.activeId);
    if (!entry) throw new Error(t('브라우저 탭을 찾지 못했습니다'));
    return { wc: entry.handle, page: entry.page };
  }

  activeWebContents() {
    return this.tabs.get(this.activeId)?.handle || null;
  }

  list() {
    return [...this.tabs.values()].filter((e) => isWebUrl(e.page.url())).map((e) => ({
      id: e.id,
      title: e.title || e.url || t('새 탭'),
      url: e.url,
      loading: false,
      favicon: null,
      canGoBack: true,
      canGoForward: true,
    }));
  }

  changed() {
    this.emit('change', { tabs: this.list(), activeTabId: this.activeId });
  }

  async create(url, activate = true) {
    const browser = await this.engine.connect();
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    const id = this.register(page);
    await page.goto(normalizeInput(url, this.settings), { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (activate) {
      this.activeId = id;
      await page.bringToFront().catch(() => {});
    }
    await this.applyDownloads(); // Playwright may reconfigure downloads for new pages
    this.changed();
    return { id };
  }

  activate(id) {
    const entry = this.tabs.get(Number(id));
    if (!entry) return;
    this.activeId = entry.id;
    entry.page.bringToFront().catch(() => {});
    this.changed();
  }

  close(id) {
    this.tabs.get(Number(id))?.page.close().catch(() => {});
  }

  go(input) {
    const entry = this.tabs.get(this.activeId);
    if (!entry) return this.create(input, true);
    entry.page.goto(normalizeInput(input, this.settings), { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  /** Brings the Chrome window to the front (the "브라우저 창 보기" button). */
  async show() {
    const { page } = await this.activePage();
    await page.bringToFront().catch(() => {});
  }

  // The browser area of the ANB window is not used by this engine.
  setBounds() {}
  setHidden() {}
  layout() {}
}

module.exports = { ChromeTabs };

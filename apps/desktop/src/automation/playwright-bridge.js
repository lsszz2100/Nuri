// Connects Playwright to this app's own Chromium (CDP on 127.0.0.1) and maps tabs to Pages.
// Playwright gives us iframe-aware aria snapshots with refs, auto-waiting actions and
// reliable typing into contenteditable editors (e.g. Naver SmartEditor).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { chromium } = require('playwright-core');
const { log } = require('../logger');
const { t } = require('../i18n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readDevToolsPort() {
  // Chromium writes the chosen port (for --remote-debugging-port=0) to this file.
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
  const port = parseInt(first, 10);
  if (!port) throw new Error('DevToolsActivePort is empty');
  return port;
}

class PlaywrightBridge {
  constructor({ fixedPort } = {}) {
    this.fixedPort = fixedPort && fixedPort !== '0' ? parseInt(fixedPort, 10) : null;
    this.browser = null;
    this.connecting = null;
    this.pages = new Map(); // webContents.id -> Page
  }

  /** The CDP port of this app's Chromium (for the script runner). */
  port() {
    return this.fixedPort || readDevToolsPort();
  }

  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const port = this.port();
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
      browser.on('disconnected', () => {
        this.browser = null;
        this.pages.clear();
      });
      log('playwright connected on port', port);
      this.browser = browser;
      this.cdp = await browser.newBrowserCDPSession();
      await this.restoreDownloads();
      return browser;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Playwright redirects downloads of the contexts it attaches to into its own temp folder.
   * Put every browser context back to Chromium's default so the user's downloads behave normally.
   */
  async restoreDownloads() {
    if (!this.cdp) return;
    try {
      const { browserContextIds = [] } = await this.cdp.send('Target.getBrowserContexts');
      for (const id of [null, ...browserContextIds]) {
        await this.cdp
          .send('Browser.setDownloadBehavior', id ? { behavior: 'default', browserContextId: id } : { behavior: 'default' })
          .catch(() => {});
      }
    } catch (e) {
      log('restoreDownloads failed', e.message);
    }
  }

  forget(webContentsId) {
    this.pages.delete(webContentsId);
  }

  /** Finds the Playwright Page for a tab's webContents by planting a nonce in the page. */
  async pageFor(wc) {
    const cached = this.pages.get(wc.id);
    if (cached && !cached.isClosed()) return cached;

    const browser = await this.connect();
    const nonce = crypto.randomUUID();
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        await wc.executeJavaScript(`window.__anbNonce = ${JSON.stringify(nonce)}`, true);
      } catch {
        /* page mid-navigation; retry */
      }
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          const value = await page.evaluate(() => window.__anbNonce).catch(() => null);
          if (value === nonce) {
            page.setDefaultTimeout(8000);
            page.setDefaultNavigationTimeout(20_000);
            this.pages.set(wc.id, page);
            await this.restoreDownloads(); // a newly attached context may have been reconfigured
            return page;
          }
        }
      }
      await sleep(200);
    }
    throw new Error(t('자동화 엔진이 현재 탭을 찾지 못했습니다'));
  }
}

module.exports = { PlaywrightBridge };

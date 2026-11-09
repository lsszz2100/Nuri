// Google sign-in for the single-window app.
// Google refuses sign-in inside embedded browsers, so the sign-in itself happens in a small window
// of the Chromium bundled with ANB (vendor/chrome-win64, a real browser). When the user has signed
// in, the session cookies are imported into the app's own browser session — the same thing a
// browser's "import from Chrome" does — and the small window closes. The login profile is kept,
// so signing in again later only needs a click.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ChromeEngine } = require('./chrome/engine');
const { t } = require('./i18n');

const SIGNED_IN = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where to go after sign-in: the `continue` target of a Google sign-in/rejected URL. */
function continueTarget(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)google\.com$/i.test(u.hostname)) return /^https?:/i.test(url) ? url : null;
    const next = u.searchParams.get('continue') || u.searchParams.get('followup');
    if (next && /^https:\/\//i.test(next) && !/^https:\/\/accounts\.google\.com\/(v\d\/)?signin/i.test(next)) return next;
  } catch {
    /* not a URL */
  }
  return null;
}

/** A CDP cookie as session `cookies.set` details, or null when it cannot be carried over. */
function toSessionCookie(c) {
  if (!c?.name || !c.domain || c.partitionKey) return null;
  const host = c.domain.replace(/^\./, '');
  const details = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  // Host-only cookies (no leading dot) and __Host- cookies must not name a domain.
  if (c.domain.startsWith('.') && !c.name.startsWith('__Host-')) details.domain = c.domain;
  const same = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite];
  if (same) details.sameSite = same;
  if (!c.session && c.expires > 0) details.expirationDate = c.expires;
  return details;
}

class GoogleLogin extends EventEmitter {
  /**
   * @param {{exe: string, profileDir: string, log?: Function}} opts
   */
  constructor({ exe, profileDir, log }) {
    super();
    this.exe = exe;
    this.profileDir = profileDir;
    this.log = log || (() => {});
    this.running = null;
  }

  /**
   * Opens the sign-in window and waits until the user has signed in (or closed the window).
   * @param {{session: object, startUrl?: string, continueUrl?: string, timeoutMs?: number}} opts
   * @returns {Promise<{ok: boolean, imported?: number, url?: string, reason?: string}>}
   */
  run(opts) {
    if (this.running) {
      this.engine?.context()?.pages()[0]?.bringToFront().catch(() => {});
      return this.running;
    }
    this.running = this.flow(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async flow({ session, startUrl, continueUrl, timeoutMs = 10 * 60_000 }) {
    const next = continueUrl || 'https://myaccount.google.com/';
    const engine = new ChromeEngine({
      exe: this.exe,
      name: t('Google 로그인'),
      profileDir: this.profileDir,
      log: this.log,
      extraArgs: ['--window-size=520,760', '--disable-extensions'],
    });
    this.engine = engine;
    let closed = false;
    engine.on('closed', () => (closed = true));
    try {
      const browser = await engine.connect();
      const ctx = browser.contexts()[0];
      const page = ctx.pages()[0] || (await ctx.newPage());
      const cdp = await browser.newBrowserCDPSession();
      const cookies = async () => (await cdp.send('Storage.getCookies')).cookies || [];
      const signedIn = (list) => list.some((c) => SIGNED_IN.has(c.name) && /(^|\.)google\.com$/i.test(c.domain.replace(/^\./, '')));
      // The blocked URL itself: a "verify it's you" check only happens there, ServiceLogin would pass straight through.
      await page.goto(startUrl || `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(next)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.bringToFront().catch(() => {});
      this.emit('state', { state: 'waiting' });
      this.log('google login: window open');

      const t0 = Date.now();
      let list = [];
      for (;;) {
        if (closed || !browser.isConnected()) {
          // A verification popup closes itself when done; the last cookies read are still good.
          if (startUrl && signedIn(list)) break;
          return { ok: false, reason: t('로그인 창이 닫혔습니다') };
        }
        if (Date.now() - t0 > timeoutMs) return { ok: false, reason: t('시간이 초과되었습니다') };
        await sleep(1000);
        list = await cookies().catch(() => list);
        const onAccounts = ctx.pages().some((p) => /^https:\/\/accounts\.google\.com\//i.test(p.url()));
        if (signedIn(list) && !onAccounts) break; // signed in and Google sent the user on
      }
      await sleep(800); // let the last redirects set their cookies
      if (browser.isConnected()) list = await cookies().catch(() => list);
      let imported = 0;
      for (const c of list) {
        const details = toSessionCookie(c);
        if (!details) continue;
        try {
          await session.cookies.set(details);
          imported++;
        } catch (e) {
          this.log('google login: cookie skipped', c.name, c.domain, e.message);
        }
      }
      await session.cookies.flushStore().catch(() => {});
      const url = ctx.pages().map((p) => p.url()).find((u) => /^https:/i.test(u)) || next;
      this.log('google login: imported', imported, 'cookies');
      return { ok: imported > 0, imported, url: continueUrl || url };
    } catch (e) {
      this.log('google login failed', e.message);
      return { ok: false, reason: e.message };
    } finally {
      this.engine = null;
      await engine.close().catch(() => {});
    }
  }
}

module.exports = { GoogleLogin, continueTarget, toSessionCookie, profileDirFor: (userData) => path.join(userData, 'google-login') };

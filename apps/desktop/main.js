// Nuri — Windows app.
//
// Two ways to run (설정 > 일반 > 브라우저 엔진, applied at start):
//  - "chromium" (default when bundled): Nuri = Chromium (vendor/chrome-win64, Chrome
//    for Testing) with ANB's agent in its side panel (extension). This process is the host: it has
//    no window of its own and serves the panel over a local WebSocket bridge. Google sign-in and
//    every other site work as in a normal browser.
//  - "builtin": the classic single window — sidebar + embedded Chromium tabs + agent panel.
// The LLM "brain" lives in the WSL server (subscription CLIs); this process drives the browser
// through Playwright (CDP on 127.0.0.1), and the desktop through the native helper.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, globalShortcut, session, safeStorage, Notification, ipcMain, dialog, powerMonitor, powerSaveBlocker } = require('electron');
const config = require('./src/config');
const i18n = require('./src/i18n');
const { t } = i18n;

// Must run before 'ready': profile isolation and the local automation port.
app.setName(config.APP_NAME);
// Always set: the data folder may still have its old name (see resolveUserData in src/config.js).
app.setPath('userData', config.USER_DATA);
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
// Windows notifications show the app's registered name and icon; an unregistered app shows the
// exe's default name. Register ours under HKCU (per user, no admin) and use that ID.
const APP_ID = 'Nuri.Desktop';
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
  const { execFile } = require('node:child_process');
  execFile('reg', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Nuri', '/f'], { windowsHide: true }, () => {});
  execFile('reg', ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', APP_ICON.replace(/\.png$/, '.ico'), '/f'], { windowsHide: true }, () => {});
}
app.commandLine.appendSwitch('remote-debugging-port', config.DEBUG_PORT);

const { log } = require('./src/logger');
const { ServerClient } = require('./src/server-client');
const { TabManager } = require('./src/tabs');
const { PlaywrightBridge } = require('./src/automation/playwright-bridge');
const { Agent } = require('./src/agent/agent');
const { registerIpc, startTask } = require('./src/ipc');
const { Schedules, runGoal, describe: describeSchedule } = require('./src/schedules');
const { DesktopHelper, HELPER_EXE } = require('./src/desktop/helper');
const { SandboxPC } = require('./src/sandbox/sandbox');
const { DesktopSession } = require('./src/desktop/session');
const { Downloads } = require('./src/downloads');
const { Autopilot } = require('./src/workflow/autopilot');
const { Settings } = require('./src/settings');
const { ChromeEngine } = require('./src/chrome/engine');
const { ChromeTabs } = require('./src/chrome/tabs');
const { makeRouter } = require('./src/host/router');
const { BridgeServer } = require('./src/host/bridge-server');
const { prepareExtension, templateId } = require('./src/host/extension-pack');
const { GoogleLogin, continueTarget, profileDirFor } = require('./src/google-login');
const { GoogleBrowser } = require('./src/google-browser');
const { cleanUploads } = require('./src/attachments');
const { applyAutostart, startedByAutostart } = require('./src/autostart');
const { createUiDialog } = require('./src/ui-dialog');

const BUNDLED_BROWSER = path.join(config.ROOT, 'vendor', 'chrome-win64', 'chrome.exe');

let win = null; // classic window (builtin engine only)
let host = null; // { engine, tabs, bridge } in Nuri mode
let tray = null;
let showMainWindow = null; // classic window: show it again (also from the tray)

async function start() {
  const settings = new Settings(path.join(app.getPath('userData'), 'anb-settings.json'));
  // 설정 > 화면 > 언어: main-process text (tray, dialogs, notifications, agent messages) and the
  // UI, which reads it once on load (preload) and reloads when it changes.
  const applyLang = () => i18n.setLang(i18n.resolveLang(settings.get('appearance.language'), app.getLocale()));
  applyLang();
  ipcMain.on('i18n:lang', (e) => {
    e.returnValue = i18n.getLang();
  });
  settings.on('change', (changed) => 'appearance.language' in changed && applyLang());
  const browserMode = settings.get('general.browserEngine') !== 'builtin' && fs.existsSync(BUNDLED_BROWSER);
  const router = makeRouter(ipcMain);
  let bridgeServer = null;
  let uiFocused = false; // side panel focus (reported by the panel)
  let lastServerState = { state: 'checking' };

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    bridgeServer?.broadcast(channel, payload);
  };
  settings.on('change', (_changed, values) => send('settings:changed', values));
  const syncAutostart = () => {
    try {
      log('autostart', applyAutostart(app, settings, config.PROFILE));
    } catch (e) {
      log('autostart failed', e.message);
    }
  };
  syncAutostart();
  settings.on('change', (changed) => 'general.startWithWindows' in changed && syncAutostart());
  // Started with Windows: stay in the tray (classic window only; 예약 작업 still run).
  const startHidden = !browserMode && startedByAutostart() && settings.get('general.startInTray');
  const server = new ServerClient({
    onState: (s) => {
      lastServerState = s;
      send('server:state', s);
    },
  });
  const ensureServer = () => server.ensure().catch((e) => log('ensureServer failed', e.message));
  releaseServer = () => server.release();
  const bridge = new PlaywrightBridge({ fixedPort: config.DEBUG_PORT });
  const downloads = new Downloads({ settings });
  downloads.attach(session.fromPartition(config.PARTITION));

  let tabs;
  let engineInfo;
  let googleLogin = null;
  const handleShortcut = (input) => {
    if (input.type !== 'keyDown') return;
    const wc = tabs.activeWebContents();
    const key = input.key.toLowerCase();
    if (input.control && key === 't') tabs.create(undefined, true);
    else if (input.control && key === 'w') tabs.close(tabs.activeId);
    else if (input.key === 'F5') wc?.reload();
    else if (input.key === 'F12') wc?.openDevTools?.({ mode: 'detach' });
    else if (input.alt && input.key === 'ArrowLeft' && wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (input.alt && input.key === 'ArrowRight' && wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  };

  let extId = null;
  let firstRun = false;
  if (browserMode) {
    extId = templateId();
    bridgeServer = new BridgeServer({
      router,
      allowedOrigin: `chrome-extension://${extId}`,
      log,
      onMessage: (msg) => {
        if (msg.ch !== 'ui:focus') return false;
        uiFocused = !!msg.args?.[0];
        return true;
      },
      onConnect: (ws) => {
        // A side panel (re)connected: give it the current state.
        bridgeServer.broadcast('browser:engine', engineInfo, ws);
        bridgeServer.broadcast('server:state', lastServerState, ws);
        bridgeServer.broadcast('tabs:state', { tabs: tabs.list(), activeTabId: tabs.activeId }, ws);
        ensureServer();
      },
    });
    const port = await bridgeServer.start();
    const extDir = path.join(app.getPath('userData'), 'browser-extension');
    prepareExtension(extDir, { port, token: bridgeServer.token });
    const profileDir = path.join(app.getPath('userData'), 'browser-profile');
    firstRun = !fs.existsSync(profileDir);
    const engine = new ChromeEngine({
      exe: BUNDLED_BROWSER,
      name: 'Nuri',
      profileDir,
      homeUrl: () => settings.get('general.homeUrl'),
      extraArgs: [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`],
      log,
      port: process.env.ANB_CHROME_PORT ? Number(process.env.ANB_CHROME_PORT) : null,
    });
    tabs = new ChromeTabs({ engine, settings, log, downloads });
    engineInfo = { type: 'chromium', name: 'Nuri' };
    host = { engine, tabs, bridge: bridgeServer };
    // Closing the browser window closes the app (it is the app).
    engine.on('closed', () => {
      log('browser closed: quitting');
      app.quit();
    });
  } else {
    win = new BrowserWindow({
      width: 1600,
      height: 980,
      minWidth: 1100,
      minHeight: 700,
      title: 'Nuri',
      icon: APP_ICON,
      show: !startHidden,
      backgroundColor: '#ffffff',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#f4f4f6', symbolColor: '#3a3a45', height: 44 },
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    tabs = new TabManager(win, { onShortcut: handleShortcut, settings });
    tabs.on('closed', (wc) => bridge.forget(wc.id));
    // Google sign-in: done in a small window of the bundled Chromium, then imported (google-login.js).
    googleLogin = fs.existsSync(BUNDLED_BROWSER) ? new GoogleLogin({ exe: BUNDLED_BROWSER, profileDir: profileDirFor(app.getPath('userData')), log }) : null;
    // A tab wanted Google's sign-in: the agent panel shows a "Google 로그인" card; its button runs this.
    let loginWanted = null; // { tabId, url } of the last tab that needed it
    const signInGoogle = async (info = loginWanted || { tabId: tabs.activeId }) => {
      if (!googleLogin) return send('browser:loginBlocked', { ...info, state: 'manual' });
      if (googleLogin.running) return googleLogin.run(); // already open: bring it to the front
      send('browser:loginBlocked', { ...info, state: 'waiting' });
      const r = await googleLogin.run({ session: session.fromPartition(config.PARTITION), startUrl: info.url, continueUrl: info.url ? continueTarget(info.url) : null });
      send('browser:loginBlocked', { ...info, state: r.ok ? 'done' : 'failed', reason: r.reason });
      if (!r.ok) return;
      loginWanted = null;
      const wc = tabs.tabs.get(info.tabId)?.view.webContents;
      // The page that asked for the check runs again with the new cookies; other tabs stay as they are.
      if (info.popup && wc && !wc.isDestroyed()) {
        wc.reload();
        tabs.activate(info.tabId);
      } else tabs.create(r.url, true);
    };
    tabs.on('login-blocked', async (info) => {
      loginWanted = info;
      log('google login needed', info.url.split('?')[0], info.popup ? 'popup' : '');
      // A running task moves to the Chromium window, where the Google session lives.
      if (agent.running && agent.googleBrowser) {
        agent.googleWanted = true;
        return;
      }
      // Already signed in: no login window, the page continues in that browser.
      const site = tabs.tabs.get(info.tabId)?.view.webContents.getURL() || '';
      const cookies = await session.fromPartition(config.PARTITION).cookies.get({ name: 'SID' }).catch(() => []);
      if (cookies.length && agent.googleBrowser && /^https:/i.test(site) && !/^https:\/\/accounts\.google\.com\//i.test(site)) {
        send('browser:loginBlocked', { ...info, state: 'chromium' });
        return agent.googleBrowser.openPage(site).catch((e) => log('open in chromium failed', e.message));
      }
      send('browser:loginBlocked', { ...info, state: googleLogin ? 'needed' : 'manual' });
      if (googleLogin && info.popup) signInGoogle(info); // a popup was expected: open the window right away
    });
    router.on('google:login', () => signInGoogle());
    tabs.on('human-check', (info) => {
      if (!agent.running && agent.googleBrowser) send('browser:loginBlocked', { ...info, state: 'humanCheck' });
    });
    router.on('browser:openChromium', (_e, url) => {
      if (/^https:\/\//i.test(String(url))) agent.googleBrowser?.openPage(String(url)).catch((e) => log('open in chromium failed', e.message));
    });
    engineInfo = { type: 'builtin', name: t('내장 브라우저'), bundled: fs.existsSync(BUNDLED_BROWSER) };
  }
  tabs.on('change', (state) => send('tabs:state', state));

  const desktop = {
    helper: new DesktopHelper({ log }),
    sandbox: new SandboxPC({ dir: path.join(app.getPath('userData'), 'sandbox'), helperExe: HELPER_EXE, workDir: config.WORKSPACE_DIR, log }),
    session: new DesktopSession({ getMainWindow: () => (win && !win.isDestroyed() ? win : null), onStop: () => agent.stop('desktop hotkey/overlay'), log, settings }),
  };
  const agent = new Agent({ server, tabs, bridge, log, desktop, downloads, settings });
  if (googleLogin) {
    agent.googleBrowser = new GoogleBrowser({
      exe: BUNDLED_BROWSER,
      profileDir: profileDirFor(app.getPath('userData')),
      stateFile: path.join(app.getPath('userData'), 'anb-google-session.json'),
      settings,
      downloads,
      loginOpen: () => !!googleLogin.running,
      agentBusy: () => agent.running,
      log,
    });
    // What the Chromium session does shows in an app tab.
    agent.googleBrowser.on('opened', () => tabs.mirror ? tabs.activate(tabs.mirror.id) : tabs.createMirror());
    agent.googleBrowser.on('page', (p) => tabs.mirrorPage(p));
    agent.googleBrowser.on('frame', (data) => tabs.mirrorFrame(data));
    tabs.on('mirror-window', () => agent.googleBrowser.show().catch(() => {}));
    tabs.on('mirror-closed', () => agent.running || agent.googleBrowser.close());
    agent.googleBrowser.on('closed', () => tabs.mirror && tabs.close(tabs.mirror.id)); // no frozen picture
    agent.googleBrowser.on('expired', () => {
      new Notification({ title: t('Google 로그인이 만료되었습니다'), body: t('유튜브 예약 업로드를 하려면 다시 로그인해 주세요.'), icon: APP_ICON }).show();
    });
    const checkGoogle = () => agent.googleBrowser.check().catch((e) => log('google session check failed', e.message));
    setTimeout(checkGoogle, 5 * 60_000).unref?.();
    setInterval(checkGoogle, 60 * 60_000).unref?.();
  }
  const cleanCopies = () => cleanUploads(config.WORKSPACE_DIR, { log });
  cleanCopies();
  setInterval(cleanCopies, 24 * 60 * 60_000).unref?.();
  if (win) {
    const trimTabs = () => {
      if (win.isDestroyed() || win.isVisible() || agent.running) return;
      for (const url of tabs.reloadHeavy(app.getAppMetrics(), config.TAB_LIMIT_MB)) log('heavy tab reloaded', url);
    };
    setInterval(trimTabs, 10 * 60_000).unref?.();
  }
  const autopilot = new Autopilot(agent);
  agent.runAutopilot =(goal, provider, opts) => autopilot.run(goal, provider, opts);
  // 예약 작업: the UI records a scheduled run like a typed one (schedule:run arrives before 'start').
  let scheduled = null; // { id, label, goal } of the scheduled run in progress
  const schedules = new Schedules({
    file: path.join(app.getPath('userData'), 'anb-schedules.json'),
    isBusy: () => agent.running,
    log,
    crypt: safeStorage.isEncryptionAvailable()
      ? { encrypt: (text) => safeStorage.encryptString(text).toString('base64'), decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64')) }
      : null,
    run: (s) => {
      scheduled = { id: s.id, label: describeSchedule(s), goal: s.goal };
      send('schedule:run', { id: s.id, goal: s.goal, mode: s.mode, provider: s.provider, quality: s.quality, label: scheduled.label });
      startTask(agent, settings, { ...s, goal: runGoal(s), scheduled: true });
    },
  });
  schedules.on('change', (list) => send('schedules:changed', list));
  let awake = null; // keeps the PC from sleeping through a scheduled run
  agent.on('event', (ev) => {
    send('agent:event', ev);
    notify(ev, scheduled);
    if (ev.kind === 'start' && scheduled) awake = powerSaveBlocker.start('prevent-app-suspension');
    if (ev.kind === 'end' && awake !== null) {
      powerSaveBlocker.stop(awake);
      awake = null;
    }
    if (scheduled && ['done', 'error', 'stopped'].includes(ev.kind)) {
      schedules.finished(scheduled.id, ev.kind, { answer: ev.answer, files: (ev.files || []).map((f) => f.path) });
    }
    if (ev.kind === 'end') scheduled = null;
  });
  for (const kind of ['skipped', 'interrupted']) schedules.on(kind, (s) => notify({ kind }, { label: describeSchedule(s), goal: s.goal }));
  powerMonitor.on('resume', () => schedules.hold(60_000));
  schedules.on('disabled', (s) => {
    new Notification({ title: t('반복 예약을 껐습니다'), body: t('연속으로 실패해 멈췄습니다: {goal}', { goal: s.goal.slice(0, 80) }), icon: APP_ICON }).show();
  });
  schedules.start();

  // 설정 > 알림: Windows notifications while the agent UI is not being looked at.
  // `sched`: the scheduled run this event belongs to (its notifications say which schedule).
  function notify(ev, sched = null) {
    const looking = browserMode ? uiFocused : win && !win.isDestroyed() && win.isVisible() && win.isFocused();
    if (looking || !Notification.isSupported()) return;
    let title = null;
    let body = '';
    if (sched && ['done', 'error', 'stopped', 'skipped', 'interrupted'].includes(ev.kind) && settings.get('notifications.taskDone')) {
      title = `${t({ done: '예약 작업 완료', error: '예약 작업 실패', stopped: '예약 작업 중지됨', skipped: '예약 작업을 건너뛰었습니다', interrupted: '앱이 꺼져 예약 작업이 중단되었습니다' }[ev.kind])} · ${sched.label}`;
      body = scheduledSummary(ev, sched);
    } else if (['done', 'error'].includes(ev.kind) && settings.get('notifications.taskDone')) {
      title = ev.kind === 'done' ? t('작업 완료') : t('작업 오류');
      body = String(ev.answer || ev.message || '');
    } else if (['ask', 'confirm'].includes(ev.kind) && settings.get('notifications.needsAttention')) {
      title = ev.kind === 'confirm' ? t('승인이 필요합니다') : t('확인이 필요합니다');
      body = String(ev.question || '');
    }
    if (!title) return;
    const n = new Notification({ title, body: sched ? body.slice(0, 250) : body.replace(/\s+/g, ' ').slice(0, 180), silent: !settings.get('notifications.sound'), icon: APP_ICON });
    n.on('click', () => {
      if (host) return host.tabs.show().catch(() => {});
      if (showMainWindow) return showMainWindow();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    n.show();
    log('notify', title, settings.get('notifications.sound') ? 'sound' : 'silent');
  }

  // "평택시 홈페이지 공고 정리 / 결과: … / 파일 3개" for a scheduled run's notification.
  function scheduledSummary(ev, sched) {
    const oneLine = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lines = [oneLine(sched.goal, 60)];
    if (ev.kind === 'done') {
      // Autopilot answers start with "<plan title> 완료" and a blank line: skip to the summary.
      const answer = String(ev.answer || '').replace(/^[^\n]*(완료|complete)\n\n/, '');
      lines.push(oneLine(answer, 140) || t('완료했습니다'));
      if (ev.files?.length) lines.push(t('결과 파일 {n}개', { n: ev.files.length }));
    } else if (ev.kind === 'error') lines.push(oneLine(ev.message, 140));
    else if (ev.kind === 'skipped') lines.push(t('예정 시간보다 1시간 넘게 늦어져 이번 실행은 건너뛰었습니다'));
    return lines.join('\n');
  }

  // Questions (quit, close tab) in Nuri's own dialog; the system one when the window is hidden.
  const ask = createUiDialog({ getWindow: () => win, tabs });
  registerIpc({ tabs, agent, server, ensureServer, settings, schedules, getWindow: () => win, engineInfo, ipc: router, ask });

  const shutdown = () => {
    schedules.stop();
    agent.stop('app exit');
    desktop.helper.stop();
    desktop.sandbox.stop();
    agent.googleBrowser?.close();
  };

  if (browserMode) {
    app.on('before-quit', () => {
      shutdown();
      host.engine.close();
      bridgeServer.close();
    });
    tray = new Tray(APP_ICON);
    tray.setToolTip('Nuri');
    const trayMenu = () => tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('Nuri 열기'), click: () => host.tabs.show().catch(() => host.engine.launch()) },
        { type: 'separator' },
        { label: t('종료'), click: () => app.quit() },
      ]),
    );
    trayMenu();
    settings.on('change', (changed) => 'appearance.language' in changed && trayMenu());
    tray.on('click', () => host.tabs.show().catch(() => {}));
    ensureServer();
    await host.engine.connect();
    // The browser starts on about:blank: show the welcome page (first start) or the home page.
    {
      const ctx = host.engine.context();
      const page = ctx?.pages().find((p) => /^(about:blank|chrome-error|chrome:\/\/newtab)?$/.test(p.url()) || p.url() === 'about:blank') || (await ctx?.newPage());
      const url = firstRun ? `chrome-extension://${extId}/welcome.html` : settings.get('general.homeUrl');
      await page?.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => log('start page', e.message));
    }
    await tabs.refresh().catch(() => {});
    tabs.changed();
    log('Nuri started (browser mode)');
    return;
  }

  // Classic window: the UI page itself must never navigate away or open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (_e, input) => handleShortcut(input));
  win.webContents.on('did-finish-load', () => {
    send('browser:engine', engineInfo);
    tabs.setHidden(false, 'settings'); // a reloaded UI starts with no page or dialog covering the view
    if (!tabs.tabs.size) tabs.create(undefined, true); // first load creates the home tab
    else tabs.changed(); // later reloads ("새 작업") just resync the UI
    ensureServer();
  });
  // X button: ask before quitting. While a task runs, the window can hide in the tray and the app
  // quits by itself when the task ends (reopening it from the tray cancels that).
  let quitting = false;
  let askingQuit = false;
  let quitWhenIdle = false;
  app.on('before-quit', () => (quitting = true));
  const showWindow = () => {
    if (!win || win.isDestroyed()) return;
    quitWhenIdle = false;
    updateTray();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  showMainWindow = showWindow;
  // The tray icon stays while the app runs, so a hidden app (closed to the tray, or started with
  // Windows) can be reopened and shows what it is doing.
  function updateTray() {
    if (!tray) return;
    const next = schedules.upcoming();
    const status = agent.running
      ? t('작업 실행 중')
      : quitWhenIdle
        ? t('작업이 끝나면 종료합니다')
        : next
          ? t('다음 예약: {label}', { label: next.label })
          : '';
    tray.setToolTip(status ? `Nuri — ${status}` : 'Nuri');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('열기'), click: showWindow },
        ...(status ? [{ label: status, enabled: false }] : []),
        { type: 'separator' },
        {
          label: t('Windows 시작 시 자동 실행'),
          type: 'checkbox',
          checked: settings.get('general.startWithWindows'),
          click: (item) => settings.update({ 'general.startWithWindows': item.checked }),
        },
        { type: 'separator' },
        { label: agent.running ? t('지금 종료 (작업 중단)') : t('종료'), click: () => app.quit() },
      ]),
    );
  }
  tray = new Tray(APP_ICON);
  tray.on('click', showWindow);
  updateTray();
  schedules.on('change', updateTray);
  settings.on('change', (changed) => ('general.startWithWindows' in changed || 'appearance.language' in changed) && updateTray());
  if (startHidden) log('started with Windows: hidden in the tray');
  let trayNoticeShown = false;
  const hideToTray = (thenQuit) => {
    quitWhenIdle = thenQuit;
    updateTray();
    win.hide();
    // Tell once per run where the app went (or always when it will quit by itself).
    if ((thenQuit || !trayNoticeShown) && Notification.isSupported()) {
      trayNoticeShown = true;
      new Notification({
        title: thenQuit ? t('작업이 끝나면 종료합니다') : t('트레이에서 실행 중입니다'),
        body: thenQuit ? t('작업은 계속 진행됩니다. 트레이 아이콘을 누르면 다시 열립니다.') : t('트레이 아이콘을 누르면 다시 열립니다.'),
        silent: true,
        icon: APP_ICON,
      }).show();
    }
  };
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    const busy = agent.running;
    const action = settings.get('general.closeAction');
    if (action === 'tray') return hideToTray(false); // a running task just keeps going
    if (action === 'quit' && !busy) return app.quit();
    if (askingQuit) return;
    askingQuit = true;
    const question = busy
      ? {
          icon: 'busy',
          title: t('작업이 진행 중입니다'),
          detail: t('지금 종료하면 진행 중인 작업이 중단됩니다. 트레이로 숨기면 작업을 끝까지 마친 뒤 종료합니다.'),
          buttons: [{ label: t('트레이로 숨기고 끝나면 종료'), style: 'primary' }, { label: t('지금 종료'), style: 'danger' }, { label: t('취소'), style: 'ghost' }],
          defaultId: 0,
          cancelId: 2,
        }
      : {
          icon: 'quit',
          title: t('Nuri를 종료할까요?'),
          detail: t('트레이로 숨기면 앱이 계속 실행되어 예약 작업이 정해진 시간에 실행됩니다'),
          buttons: [{ label: t('종료'), style: 'primary' }, { label: t('트레이로 숨기기'), style: 'ghost' }, { label: t('취소'), style: 'ghost' }],
          defaultId: 0,
          cancelId: 2,
          checkbox: t('다음부터 묻지 않고 이 선택대로 하기'),
        };
    ask(question)
      .then(({ response: r, checked }) => {
        if (r === 2) return;
        // "Remember": 설정 > 일반 > 창 닫기(X) 버튼 follows this choice from now on.
        if (!busy && checked) settings.update({ 'general.closeAction': r === 0 ? 'quit' : 'tray' });
        if (busy ? r === 1 : r === 0) app.quit();
        else hideToTray(busy);
      })
      .catch((err) => log('quit dialog failed', err.message))
      .finally(() => (askingQuit = false));
  });
  agent.on('event', (ev) => {
    if (ev.kind === 'start' || ev.kind === 'end') updateTray();
    if (ev.kind === 'end' && quitWhenIdle) {
      log('task finished: quitting (was hidden in tray)');
      setTimeout(() => app.quit(), 1500); // let the "작업 완료" notification show
    }
  });
  win.on('closed', () => {
    shutdown();
    win = null;
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

Menu.setApplicationMenu(null);

// On quit, give the AI engine server back its lease first (an installed server then stops by
// itself, src/server-client.js), waiting at most about a second.
let releaseServer = null;
let serverReleased = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (host) return host.tabs.show().catch(() => host.engine.launch().catch(() => {}));
    if (showMainWindow) return showMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() =>
    start().catch((e) => {
      log('start failed', e.stack || e.message);
      app.quit();
    }),
  );
  // Browser mode has no windows of its own: keep running while the browser is open.
  app.on('window-all-closed', () => {
    if (!host) app.quit();
  });
  app.on('will-quit', (e) => {
    globalShortcut.unregisterAll();
    if (releaseServer && !serverReleased) {
      e.preventDefault();
      serverReleased = true;
      releaseServer()
        .catch(() => {})
        .finally(() => app.quit());
    }
  });
}

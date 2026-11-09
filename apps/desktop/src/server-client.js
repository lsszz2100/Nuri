// Talks to the orchestrator server (the AI engine): starts it when needed and sends authenticated
// requests. The server runs in WSL, or natively on Windows when the CLIs are installed there.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SERVER, TOKEN_FILE, SERVER_SCRIPT, SERVER_JS, SERVER_MODE, SERVER_DATA_DIR, DATA_ROOT, WORKSPACE_DIR, PACKAGED, LOG_DIR } = require('./config');
const { log } = require('./logger');
const { t } = require('./i18n');

const CLIS = ['claude', 'codex', 'agy'];

/** Subscription CLIs installed on Windows itself (PATH, ~/.local/bin, npm global folder). */
function windowsClis(env = process.env) {
  const home = os.homedir();
  const dirs = [...String(env.PATH || env.Path || '').split(';').filter(Boolean), path.join(home, '.local', 'bin'), path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')];
  return CLIS.filter((c) => dirs.some((d) => ['.exe', '.cmd'].some((ext) => fs.existsSync(path.join(d, c + ext)))));
}

/**
 * 'native' or 'wsl' for this machine. Auto picks Windows only when every CLI is installed there:
 * with one missing (often agy), that model would stop working.
 */
function serverMode(mode = SERVER_MODE, platform = process.platform, clis = () => windowsClis()) {
  if (platform !== 'win32') return 'native';
  if (mode !== 'auto') return mode;
  return clis().length === CLIS.length ? 'native' : 'wsl';
}

const LEASE_EVERY_MS = 30_000;

/** Same as the server's buildIdOf (routes/lifecycle.ts): size + whole seconds of mtime. */
function buildIdOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${Math.floor(st.mtimeMs / 1000)}`;
  } catch {
    return 'unknown';
  }
}

const tokenIdOf = (token) => (token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : null);

/**
 * Whether a running server can be used as is: 'ok', 'outdated' (ours, but an older build: e.g.
 * left running across an update) or 'foreign' (another profile's or install's token).
 * Old servers report no build/token: treated as outdated when the token is unknown to them.
 */
function judgeServer(health, { token, build }) {
  if (!health) return 'ok';
  if (health.tokenId === undefined) return 'outdated';
  if (token && health.tokenId !== tokenIdOf(token)) return 'foreign';
  if (!token) return 'foreign'; // our data folder has no token: that server did not start from it
  if (build !== 'unknown' && health.build !== build) return 'outdated';
  return 'ok';
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function toWslPath(p) {
  const full = path.resolve(p);
  const m = /^([A-Za-z]):\\(.*)$/.exec(full);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : full.replace(/\\/g, '/');
}

class ServerClient {
  constructor({ onState } = {}) {
    this.onState = onState || (() => {});
    this.token = null;
  }

  readToken() {
    try {
      this.token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch {
      this.token = null;
    }
    return this.token;
  }

  async isUp() {
    return !!(await this.health());
  }

  /** The /v1/health answer, or null when nothing answers. */
  async health() {
    try {
      const res = await fetch(`${SERVER}/v1/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? await res.json().catch(() => ({})) : null;
    } catch {
      return null;
    }
  }

  /**
   * Installed app only: a running server must be this install's current build with our token.
   * An outdated one is stopped (so updates take effect); a foreign one is reported.
   * Returns an error message, or null when it is fine to (re)use / start the server.
   */
  async checkRunning(health) {
    if (!PACKAGED || !health) return null;
    const verdict = judgeServer(health, { token: this.readToken(), build: buildIdOf(SERVER_JS) });
    if (verdict === 'ok') return null;
    const port = new URL(SERVER).port;
    if (verdict === 'foreign') {
      log('server foreign', port, health.pid);
      return t('포트 {port}를 다른 Nuri(다른 프로필이나 설치본)의 AI 엔진이 쓰고 있습니다. 그 프로그램을 닫고 다시 시도하세요.', { port });
    }
    log('server outdated: stopping', health.build, '->', buildIdOf(SERVER_JS));
    await this.post('/v1/shutdown', {}).catch(() => {});
    const until = Date.now() + 10_000;
    while (Date.now() < until && (await this.isUp())) await new Promise((r) => setTimeout(r, 300));
    return (await this.isUp()) ? t('이전 버전의 AI 엔진 서버(포트 {port})가 종료되지 않습니다. PC를 다시 시작하거나 작업 관리자에서 종료하세요.', { port }) : null;
  }

  async post(pathname, body, timeout = 2000) {
    const res = await fetch(`${SERVER}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ANB-Token': this.token || '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    return res.ok;
  }

  /** Tells the server this app still uses it (the installed server exits when nobody does). */
  startLease() {
    if (this.leaseTimer) return;
    const beat = () => this.post('/v1/lease', { client: `app-${process.pid}` }).catch(() => {});
    beat();
    this.leaseTimer = setInterval(beat, LEASE_EVERY_MS);
    this.leaseTimer.unref?.();
  }

  /** On quit: release the lease so an installed server stops a few seconds later. */
  async release() {
    clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    await this.post('/v1/lease', { client: `app-${process.pid}`, release: true }, 1000).catch(() => {});
  }

  /** Starts the server if needed; concurrent callers share one attempt. */
  ensure() {
    if (!this.pending) this.pending = this.start().finally(() => (this.pending = null));
    return this.pending;
  }

  async start() {
    this.onState({ state: 'checking' });
    const running = await this.health();
    const problem = await this.checkRunning(running);
    if (problem) return this.onState({ state: 'error', message: problem });
    if (running && (await this.isUp())) {
      this.readToken();
      this.startLease();
      return this.onState({ state: 'ready' });
    }
    this.onState({ state: 'starting' });
    this.mode = serverMode();
    log('server start', this.mode);
    if (this.mode === 'native') this.startNative();
    else this.startWsl();
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.isUp()) {
        this.readToken();
        this.startLease();
        return this.onState({ state: 'ready' });
      }
    }
    this.onState({ state: 'error', message: t('AI 엔진 서버가 응답하지 않습니다. logs/{file}를 확인하세요.', { file: this.mode === 'native' && process.platform === 'win32' ? 'server-win.log' : 'server.log' }) });
  }

  /**
   * Server on Windows: the app runtime runs it as plain Node (env below), so no separate
   * Node install is needed. Started through Start-Process for the same reason as WSL below.
   */
  startNative() {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const port = new URL(SERVER).port || '3456';
      if (process.platform !== 'win32') {
        // macOS / Linux: no PowerShell; a detached child with its output in the log.
        const fd = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: port, DATA_DIR: SERVER_DATA_DIR, ANB_WORKSPACE_DIR: WORKSPACE_DIR, ...(PACKAGED ? { ANB_EXIT_WHEN_IDLE: '1' } : {}) };
        fs.mkdirSync(DATA_ROOT, { recursive: true });
        spawn(process.execPath, [SERVER_JS], { cwd: DATA_ROOT, env, detached: true, stdio: ['ignore', fd, fd] }).unref();
        fs.closeSync(fd);
        return;
      }
      const out = path.join(LOG_DIR, 'server-win.log'); // overwritten per start (WSL appends to server.log)
      const cmd = `Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(`"${SERVER_JS}"`)} -WorkingDirectory ${psQuote(DATA_ROOT)} -WindowStyle Hidden -RedirectStandardOutput ${psQuote(out)} -RedirectStandardError ${psQuote(out + '.err')}`;
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: port, DATA_DIR: SERVER_DATA_DIR, ANB_WORKSPACE_DIR: WORKSPACE_DIR, ...(PACKAGED ? { ANB_EXIT_WHEN_IDLE: '1' } : {}) };
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, stdio: 'ignore', env });
      child.on('error', (e) => log('server spawn error', e.message));
      child.unref();
    } catch (e) {
      log('server spawn failed', e.message);
    }
  }

  startWsl() {
    try {
      // wsl.exe must stay alive: background jobs inside WSL die when wsl.exe exits. Start it via
      // Start-Process so it does not inherit our handles (a directly spawned wsl.exe kept the
      // app's CDP port listening after the app quit).
      // The installed app tells the script where its server bundle and data folders are.
      const args = ['-e', '/bin/bash', toWslPath(SERVER_SCRIPT)];
      if (PACKAGED) args.push(toWslPath(SERVER_JS), toWslPath(SERVER_DATA_DIR), toWslPath(LOG_DIR), toWslPath(WORKSPACE_DIR), new URL(SERVER).port || '3456', 'idle');
      // Windows PowerShell joins -ArgumentList with spaces without quoting: quote the ones with
      // spaces (only those: wsl.exe does not recognize a quoted "-e").
      const cmd = `Start-Process wsl.exe -ArgumentList ${args.map((x) => psQuote(/\s/.test(x) ? `"${x}"` : x)).join(',')} -WindowStyle Hidden`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, stdio: 'ignore' });
      child.on('error', (e) => log('wsl spawn error', e.message));
      child.unref();
    } catch (e) {
      log('wsl spawn failed', e.message);
    }
  }

  async request(pathname, { method = 'GET', body, signal } = {}) {
    if (!this.token) this.readToken();
    const send = () =>
      fetch(`${SERVER}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-ANB-Token': this.token || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    let res;
    try {
      res = await send();
    } catch (e) {
      // Not reachable (e.g. a task right after launch, before the server is up): wait for it, retry once.
      if (signal?.aborted) throw e;
      await this.ensure();
      res = await send();
    }
    if (res.status === 401) {
      // Server restarted with a new token file: re-read once.
      this.readToken();
      res = await send();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('AI 엔진 오류 (HTTP {status})', { status: res.status }));
    return data;
  }
}

module.exports = { ServerClient, toWslPath, serverMode, windowsClis, judgeServer, tokenIdOf, buildIdOf };

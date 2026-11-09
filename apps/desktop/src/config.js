// Central configuration for the desktop app.
const os = require('node:os');
const path = require('node:path');

// Installed app (see package.json "build"): the app is in resources/app.asar,
// the server bundle, browser and scripts next to it, and everything the app writes (logs, work
// folder, server token) in %APPDATA%\Nuri so updates never touch it.
// From the repo: the repo root holds all of it, as before.
const PACKAGED = __dirname.includes('app.asar');
const ROOT = PACKAGED ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..'); // the repository root
// A profile can also come from the command line (--anb-profile=name): Windows' start-up entry
// (src/autostart.js) cannot set environment variables.
const ARG_PROFILE = (process.argv.find((a) => /^--anb-profile=[\w-]{1,20}$/.test(a)) || '').slice('--anb-profile='.length);
const PROFILE = process.env.ANB_PROFILE || ARG_PROFILE;
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const APP_NAME = 'Nuri';

/** Name of the per-user data folder in %APPDATA% ("Nuri", or "Nuri (test)" for a profile). */
function dataDirName(profile, name = APP_NAME) {
  return profile ? `${name} (${profile})` : name;
}

/**
 * The app was renamed: move the old data folder (logins, settings, schedules) to the new name
 * once. If the move fails (the old app is still running and holds files), keep using the old
 * folder so nothing is lost; the move is tried again on the next start.
 */
function resolveUserData(base, profile, fsMod = require('node:fs')) {
  const now = path.join(base, dataDirName(profile));
  const old = path.join(base, dataDirName(profile, 'AI Native Browser'));
  if (fsMod.existsSync(now) || !fsMod.existsSync(old)) return now;
  try {
    fsMod.renameSync(old, now);
    return now;
  } catch {
    return old;
  }
}

const USER_DATA = resolveUserData(appData, PROFILE);
const DATA_ROOT = PACKAGED ? USER_DATA : ROOT;

/** 3466 for the default installed profile, 3467-3966 for named ones (stable per name). */
function profilePort(profile) {
  if (!profile) return 3466;
  let h = 0;
  for (const ch of profile) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 3467 + (h % 500);
}

module.exports = {
  APP_NAME,
  dataDirName,
  resolveUserData,
  USER_DATA,
  profilePort,
  ROOT,
  PACKAGED,
  DATA_ROOT,
  // The installed app has its own port, so it never talks to a repo server (other token), and
  // each installed profile its own, so two profiles never share (and fight over) one server.
  SERVER: process.env.ANB_SERVER || (PACKAGED ? `http://127.0.0.1:${profilePort(PROFILE)}` : 'http://127.0.0.1:3456'),
  SERVER_DATA_DIR: path.join(DATA_ROOT, '.anb-data'),
  TOKEN_FILE: path.join(DATA_ROOT, '.anb-data', 'auth-token'),
  SERVER_SCRIPT: path.join(ROOT, 'scripts', 'start-server.sh'),
  // The server itself (built; one bundled file when installed). Run natively on Windows with
  // the app runtime as Node (src/server-client.js).
  SERVER_JS: PACKAGED ? path.join(ROOT, 'server', 'server.mjs') : path.join(ROOT, 'packages', 'anb-orchestrator', 'dist', 'server.js'),
  // Helper exe and scripts run by other programs: outside the asar archive when installed.
  NATIVE_DIR: PACKAGED ? path.join(ROOT, 'app.asar.unpacked', 'native') : path.join(__dirname, '..', 'native'),
  // Where the AI engine server runs: auto = on Windows when all subscription CLIs (claude,
  // codex, agy) are installed there, otherwise in WSL; wsl / native force one.
  SERVER_MODE: ['wsl', 'native'].includes(process.env.ANB_SERVER_MODE) ? process.env.ANB_SERVER_MODE : 'auto',
  LOG_DIR: path.join(DATA_ROOT, 'logs'),
  // Test instances (ANB_PROFILE=test) get their own workspace so they never touch the user's profile/projects.
  WORKSPACE_DIR: PACKAGED ? path.join(DATA_ROOT, 'workspace') : path.join(ROOT, PROFILE ? `workspace-${PROFILE}` : 'workspace'),
  HOME_URL: 'https://www.google.com',
  PARTITION: 'persist:anb', // keeps logins/cookies between runs
  // Separate profile for automated tests (ANB_PROFILE=test) so they never touch the user's window.
  PROFILE,
  // Fixed CDP port only for external test tooling; otherwise Chromium picks a free port.
  DEBUG_PORT: process.env.ANB_DEBUG_PORT || '0',
  TAB_LIMIT_MB: Number(process.env.ANB_TAB_LIMIT_MB) || 1024, // src/tab-memory.js
  chromeUserAgent() {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  },
};

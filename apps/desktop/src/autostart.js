// "Windows 시작 시 자동 실행" (설정 > 일반 > 시작 · 종료): a per-user start-up entry
// (HKCU\...\Run, written by app.setLoginItemSettings) that starts this app with --autostart.
// With general.startInTray the app then starts in the tray, so 예약 작업 run without the window.

const AUTOSTART_ARG = '--autostart';

/** Name of the start-up entry; test profiles get their own so they never replace the user's. */
function entryName(profile, name = 'Nuri') {
  return profile ? `${name} (${profile})` : name;
}

/** Name the start-up entry had before the app was renamed. */
const OLD_NAME = 'AI Native Browser';

/**
 * Options for app.setLoginItemSettings. When the app runs unpackaged (dev runtime exe), the
 * app folder must be passed as the first argument.
 */
function loginItemOptions({ on, execPath, appPath, packaged, profile }) {
  const args = [];
  if (!packaged) args.push(appPath);
  args.push(AUTOSTART_ARG);
  if (profile) args.push(`--anb-profile=${profile}`);
  return { openAtLogin: !!on, path: execPath, args, name: entryName(profile) };
}

/** True when this process was started by the start-up entry. */
function startedByAutostart(argv = process.argv) {
  return argv.includes(AUTOSTART_ARG);
}

/** Writes (or removes) the start-up entry to match the setting; returns the command line it set. */
function applyAutostart(app, settings, profile) {
  if (process.platform !== 'win32') return 'unsupported';
  const opts = loginItemOptions({
    on: settings.get('general.startWithWindows'),
    execPath: process.execPath,
    appPath: app.getAppPath(),
    packaged: app.isPackaged,
    profile,
  });
  app.setLoginItemSettings(opts);
  // Remove the entry left by the old name, or Windows would start the app twice.
  app.setLoginItemSettings({ ...opts, openAtLogin: false, name: entryName(profile, OLD_NAME) });
  return opts.openAtLogin ? [opts.path, ...opts.args].join(' ') : 'removed';
}

module.exports = { AUTOSTART_ARG, entryName, loginItemOptions, startedByAutostart, applyAutostart };

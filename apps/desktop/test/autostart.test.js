const test = require('node:test');
const assert = require('node:assert');
const { loginItemOptions, startedByAutostart, entryName } = require('../src/autostart');
const { Settings } = require('../src/settings');

test('start-up entry: unpackaged app passes its folder, then --autostart', () => {
  const o = loginItemOptions({ on: true, execPath: 'C:\\e\\nuri.exe', appPath: 'D:\\app', packaged: false, profile: '' });
  assert.deepStrictEqual(o, { openAtLogin: true, path: 'C:\\e\\nuri.exe', args: ['D:\\app', '--autostart'], name: 'Nuri' });
});

test('start-up entry: packaged app, test profile gets its own entry and profile argument', () => {
  const o = loginItemOptions({ on: false, execPath: 'C:\\ANB.exe', appPath: 'x', packaged: true, profile: 'test' });
  assert.deepStrictEqual(o.args, ['--autostart', '--anb-profile=test']);
  assert.strictEqual(o.name, entryName('test'));
  assert.notStrictEqual(o.name, entryName(''));
  assert.strictEqual(o.openAtLogin, false);
});

test('startedByAutostart reads the argument', () => {
  assert.strictEqual(startedByAutostart(['nuri.exe', 'D:\\app', '--autostart']), true);
  assert.strictEqual(startedByAutostart(['nuri.exe', 'D:\\app']), false);
});

test('start/close settings: defaults and validation', () => {
  const s = new Settings(require('node:path').join(require('node:os').tmpdir(), `anb-autostart-${process.pid}.json`));
  assert.strictEqual(s.get('general.startWithWindows'), false);
  assert.strictEqual(s.get('general.startInTray'), true);
  assert.strictEqual(s.get('general.closeAction'), 'ask');
  assert.deepStrictEqual(s.update({ 'general.closeAction': 'minimize' }).rejected, ['general.closeAction']);
  s.update({ 'general.closeAction': 'tray', 'general.startWithWindows': true });
  assert.strictEqual(s.get('general.closeAction'), 'tray');
  require('node:fs').rmSync(s.file, { force: true });
});

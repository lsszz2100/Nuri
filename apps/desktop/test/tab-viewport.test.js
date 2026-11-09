const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// src/tabs.js only needs the runtime's session at construction: give it a stub to load in plain Node.
const load = Module._load;
const ses = { setUserAgent() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
Module._load = (req, ...rest) => (req === 'electron' ? { WebContentsView: function () {}, session: { fromPartition: () => ses }, shell: {} } : load(req, ...rest));
const { TabManager } = require('../src/tabs');
Module._load = load;

function setup() {
  const win = { minimized: false, visible: true, on() {}, isMinimized() { return this.minimized; }, isVisible() { return this.visible; } };
  const m = new TabManager(win);
  m.bounds = { x: 0, y: 0, width: 800, height: 600 };
  const tab = (id) => {
    const calls = [];
    const wc = { isDestroyed: () => false, enableDeviceEmulation: (p) => calls.push(['on', p.viewSize]), disableDeviceEmulation: () => calls.push(['off']) };
    return { id, calls, view: { webContents: wc } };
  };
  return { win, m, tab };
}

test('a tab opened while the window is minimized gets the page area size', () => {
  const { win, m, tab } = setup();
  const a = tab(1);
  m.activeId = 1;
  win.minimized = true;
  m.fixViewport(a);
  assert.deepStrictEqual(a.calls, [['on', { width: 800, height: 600 }]]);
  m.fixViewport(a); // same size: nothing to do
  assert.strictEqual(a.calls.length, 1);
  m.bounds = { x: 0, y: 0, width: 900, height: 600 };
  m.fixViewport(a); // resized: new size
  assert.deepStrictEqual(a.calls[1], ['on', { width: 900, height: 600 }]);
});

test('the size is handed back only when the tab is on screen', () => {
  const { win, m, tab } = setup();
  const front = tab(1);
  const back = tab(2);
  m.activeId = 1;
  win.visible = false; // in the tray
  m.fixViewport(front);
  m.fixViewport(back);
  win.visible = true;
  m.fixViewport(front);
  m.fixViewport(back);
  assert.deepStrictEqual(front.calls.at(-1), ['off']);
  assert.strictEqual(front.emulated, null);
  assert.ok(back.emulated, 'a background tab keeps its size');
  m.activeId = 2;
  m.fixViewport(back);
  assert.deepStrictEqual(back.calls.at(-1), ['off']);
});

test('tabs opened while the window is shown are left alone', () => {
  const { m, tab } = setup();
  const a = tab(1);
  const b = tab(2);
  m.activeId = 1;
  m.fixViewport(a);
  m.fixViewport(b);
  assert.deepStrictEqual([a.calls, b.calls], [[], []]);
});

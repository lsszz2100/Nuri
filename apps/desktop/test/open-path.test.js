const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// src/ipc.js needs the runtime only inside registerIpc; give it a stub to load in plain Node.
const load = Module._load;
Module._load = (req, ...rest) => (req === 'electron' ? { app: {}, ipcMain: {}, shell: {}, dialog: {} } : load(req, ...rest));
const { RUNNABLE } = require('../src/ipc');
Module._load = load;

test('runnable or mountable files are never opened from the workspace', () => {
  for (const f of ['a.exe', 'b.MSC', 'c.chm', 'd.scf', 'e.iso', 'f.appref-ms', 'g.xlsm', 'h.lnk', 'i.settingcontent-ms']) assert.ok(RUNNABLE.test(f), f);
  for (const f of ['report.xlsx', 'notes.md', 'doc.pdf', 'image.png', 'data.csv', 'paper.hwp']) assert.ok(!RUNNABLE.test(f), f);
});

// Builds the agent side-panel extension that Nuri loads (--load-extension):
// the extension template (apps/desktop/extension) + ANB's UI (apps/desktop/ui) as ui/panel.html,
// plus host.json with this run's bridge port and token. Rebuilt on every start.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TEMPLATE = path.join(__dirname, '..', '..', 'extension');
const UI = path.join(__dirname, '..', '..', 'ui');

/** Chrome extension id from the manifest's public key (first 16 bytes of SHA-256, a-p alphabet). */
function extensionId(manifestKey) {
  const hash = crypto.createHash('sha256').update(Buffer.from(manifestKey, 'base64')).digest();
  return [...hash.subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
}

function templateId() {
  return extensionId(JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'manifest.json'), 'utf8')).key);
}

/** The panel page: ANB's index.html with the WebSocket bridge instead of the app's preload. */
function panelHtml(indexHtml) {
  return indexHtml
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://127.0.0.1:*" />`)
    .replace('<script src="js/dom.js"></script>', '<script src="../anb-bridge.js"></script>\n  <script src="js/dom.js"></script>');
}

/**
 * @param {string} outDir  folder Chromium loads the extension from
 * @param {{port: number, token: string}} host
 */
function prepareExtension(outDir, host) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(TEMPLATE, outDir, { recursive: true });
  fs.cpSync(UI, path.join(outDir, 'ui'), { recursive: true });
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'ui', 'panel.html'), panelHtml(index), 'utf8');
  fs.writeFileSync(path.join(outDir, 'host.json'), JSON.stringify({ port: host.port, token: host.token }), 'utf8');
  return { dir: outDir, id: templateId() };
}

module.exports = { prepareExtension, extensionId, templateId, panelHtml };

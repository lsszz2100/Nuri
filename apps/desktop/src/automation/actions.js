// Executes one agent action on the active page with Playwright.
// Refs come from the latest aria snapshot ("e12", or "f3e7" inside iframes).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { t } = require('../i18n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|jpg|jpeg|png|gif|webp|heic|mp3|wav|m4a|pdf|docx?|xlsx?|pptx?|hwpx?|txt|csv|zip)$/i;

/** Read-only listing so the agent can locate files to upload (newest first). */
function listFiles(dir) {
  const home = os.homedir();
  const dirs = dir ? [String(dir)] : ['Desktop', 'Downloads', 'Videos', 'Pictures', 'Documents'].map((d) => path.join(home, d));
  const lines = [];
  for (const d of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      lines.push(`${d}: (cannot read: ${e.code || e.message})`);
      continue;
    }
    const items = entries
      .map((e) => {
        const full = path.join(d, e.name);
        try {
          const st = fs.statSync(full);
          return { name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs, full };
        } catch {
          return null;
        }
      })
      .filter((x) => x && (dir ? true : x.dir || MEDIA_EXT.test(x.name)))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, dir ? 60 : 15);
    lines.push(`${d}:`);
    for (const x of items) {
      const when = new Date(x.mtime).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`  ${x.dir ? '[folder] ' : ''}${x.full}${x.dir ? '' : `  (${Math.round(x.size / 1024)}KB, ${when})`}`);
    }
  }
  return lines.join('\n').slice(0, 6000);
}

async function uploadFiles(ctx, a) {
  const { page, wc } = ctx;
  const files = (Array.isArray(a.files) ? a.files : [a.files || a.file || a.path]).filter(Boolean).map(String);
  if (!files.length) return 'FAILED: upload needs "files" (absolute Windows paths)';
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) return `FAILED: file not found: ${missing.join(', ')} (use list_files to find the right path)`;
  const names = files.map((f) => path.basename(f)).join(', ');

  if (ctx.pendingChooser) {
    const chooser = ctx.pendingChooser;
    ctx.pendingChooser = null;
    await chooser.setFiles(files);
  } else if (a.ref) {
    const loc = refLocator(page, a.ref);
    const isInput = await loc.evaluate((el) => el.tagName === 'INPUT' && el.type === 'file').catch(() => false);
    if (isInput) await loc.setInputFiles(files);
    else {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), loc.click()]);
      await chooser.setFiles(files);
    }
  } else {
    // No button given: use the page's (often hidden) file input directly, in any frame.
    let done = false;
    for (const frame of page.frames()) {
      const input = frame.locator('input[type=file]').first();
      if (await input.count().catch(() => 0)) {
        await input.setInputFiles(files);
        done = true;
        break;
      }
    }
    if (!done) return 'FAILED: no file input on this page; give the ref of the upload button';
  }
  await settle(page, wc);
  return `uploaded ${names}`;
}

const KEY_ALIASES = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', 'ctrl+a': 'Control+A', 'control+a': 'Control+A',
};

function normalizeKey(key) {
  const k = String(key || 'Enter').trim();
  return KEY_ALIASES[k.toLowerCase()] || k;
}

function refLocator(page, ref) {
  if (!/^[a-z0-9]+$/i.test(String(ref || ''))) throw new Error(`invalid ref "${ref}"`);
  return page.locator(`aria-ref=${ref}`);
}

function shortError(e) {
  return String(e?.message || e).split('\n')[0].replace(/^locator\.\w+: /, '').slice(0, 220);
}

/** Visual feedback: outline the target element for a moment (drawn in the top document). */
async function highlight(page, locator, label) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  await page
    .evaluate(
      ({ box, label }) => {
        const d = document.createElement('div');
        d.style.cssText =
          'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #6366f1;border-radius:6px;' +
          'background:rgba(99,102,241,.12);box-shadow:0 0 0 4px rgba(99,102,241,.18);transition:opacity .3s;' +
          `left:${box.x - 3}px;top:${box.y - 3}px;width:${box.width + 6}px;height:${box.height + 6}px`;
        const t = document.createElement('div');
        t.textContent = label;
        t.style.cssText =
          'position:absolute;top:-24px;left:-2px;background:#6366f1;color:#fff;font:600 11px/1 system-ui,sans-serif;padding:5px 7px;border-radius:5px;white-space:nowrap';
        d.appendChild(t);
        document.documentElement.appendChild(d);
        setTimeout(() => {
          d.style.opacity = '0';
          setTimeout(() => d.remove(), 300);
        }, 900);
      },
      { box, label },
    )
    .catch(() => {});
}

/** Waits until the page stops loading, or until the DOM has been quiet for a moment (SPAs). */
async function settle(page, wc) {
  await sleep(120);
  if (wc && wc.isLoading()) {
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    await sleep(300);
    return;
  }
  await page
    .evaluate(
      () =>
        new Promise((resolve) => {
          let timer;
          const done = () => {
            obs.disconnect();
            resolve();
          };
          const obs = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, 250);
          });
          obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          timer = setTimeout(done, 250);
          setTimeout(done, 1500);
        }),
    )
    .catch(() => {});
}

const squash = (t) => String(t || '').replace(/\s+/g, '');

/** Types into rich editors line by line: Enter between lines makes real paragraphs. */
async function typeLines(page, text, perKey) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Enter');
    if (!lines[i]) continue;
    if (perKey) await page.keyboard.type(lines[i], { delay: 15 });
    else await page.keyboard.insertText(lines[i]);
  }
}

async function readText(locator) {
  return locator.evaluate((el) => (el.value !== undefined ? el.value : el.innerText) || '').catch(() => '');
}

async function typeInto(page, locator, text, clear) {
  await locator.click();
  const info = await locator.evaluate((el) => ({
    tag: el.tagName,
    editable: el.isContentEditable,
    type: el.getAttribute('type') || '',
  }));
  const plainField = (info.tag === 'INPUT' || info.tag === 'TEXTAREA') && !info.editable;
  if (plainField) {
    if (clear) await locator.fill(text);
    else await locator.pressSequentially(text, { delay: 5 });
    return 'typed';
  }
  // Rich editors (contenteditable) need real keyboard input to update their internal model.
  const clearEditor = async () => {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
  };
  if (clear) await clearEditor();
  await typeLines(page, text, false);
  // Editors that sync their model on key events (word counters, autosave, SmartEditor)
  // need a real keystroke; Shift is harmless and leaves the caret where it is.
  await page.keyboard.press('Shift');

  // Verify (whitespace-insensitive: editors turn newlines into paragraphs). The typed text may
  // also land in a sibling paragraph, so check the whole editable root, not just the target.
  const probe = squash(text).slice(0, 30);
  const root = locator.locator('xpath=ancestor-or-self::*[@contenteditable="true"][last()]');
  const got = squash((await readText(root.first())) || (await readText(locator)));
  if (probe && !got.includes(probe)) {
    // Some editors ignore insertText: retype key by key (after clearing what may have landed).
    if (clear) await clearEditor();
    await typeLines(page, text, true);
    return 'typed (fallback: key by key)';
  }
  return 'typed';
}

/**
 * @param {{page, wc, tabs}} ctx  Playwright page, tab webContents, TabManager
 * @returns {Promise<string>} short result description for the agent history
 */
async function execute(ctx, action) {
  const { page, wc, tabs } = ctx;
  const a = action || {};
  try {
    switch (a.type) {
      case 'click': {
        const loc = refLocator(page, a.ref);
        await highlight(page, loc, t('AI 클릭'));
        try {
          await loc.click({ timeout: 6000 });
        } catch (e) {
          // Covered by an overlay or animating: a direct click is the next best thing.
          if (!/intercepts pointer|not stable|outside of the viewport/i.test(String(e.message))) throw e;
          await loc.click({ force: true, timeout: 4000 });
        }
        await settle(page, wc);
        if (ctx.pendingChooser) return 'clicked; a FILE CHOOSER opened — next use {"type":"upload","files":[...]} (find paths with list_files)';
        return 'clicked';
      }
      case 'type': {
        const loc = refLocator(page, a.ref);
        await highlight(page, loc, t('AI 입력'));
        const result = await typeInto(page, loc, String(a.text ?? ''), a.clear !== false);
        if (a.submit) {
          await page.keyboard.press('Enter');
          await settle(page, wc);
          return `${result} "${a.text}" + Enter`;
        }
        return `${result} "${a.text}"`;
      }
      case 'select': {
        const loc = refLocator(page, a.ref);
        const values = await loc.selectOption({ label: String(a.value) }).catch(() => loc.selectOption(String(a.value)));
        await settle(page, wc);
        return `selected ${JSON.stringify(values)}`;
      }
      case 'check': {
        await refLocator(page, a.ref).setChecked(a.checked !== false);
        return a.checked === false ? 'unchecked' : 'checked';
      }
      case 'hover': {
        await refLocator(page, a.ref).hover();
        await settle(page, wc);
        return 'hovered';
      }
      case 'press': {
        await page.keyboard.press(normalizeKey(a.key));
        await settle(page, wc);
        return `pressed ${normalizeKey(a.key)}`;
      }
      case 'scroll': {
        const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        if (a.ref) await refLocator(page, a.ref).hover();
        else await page.mouse.move(size.w / 2, size.h / 2);
        await page.mouse.wheel(0, (a.direction === 'up' ? -1 : 1) * Math.round(size.h * 0.8));
        await sleep(450);
        return `scrolled ${a.direction === 'up' ? 'up' : 'down'}`;
      }
      case 'navigate': {
        let url = String(a.url || '').trim();
        if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
        try {
          const parsed = new URL(url); // also percent-encodes spaces and Korean text
          if (!/^https?:$/.test(parsed.protocol)) return 'FAILED: only http(s) URLs are allowed';
          url = parsed.href;
        } catch {
          return 'FAILED: invalid URL';
        }
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
          if (!/ERR_ABORTED|interrupted/i.test(e.message)) throw e; // redirects abort the first request
        });
        await settle(page, wc);
        return `opened ${url}`;
      }
      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        await settle(page, wc);
        return 'went back';
      }
      case 'new_tab': {
        let url;
        if (a.url) {
          url = /^[a-z]+:/i.test(String(a.url).trim()) ? String(a.url).trim() : `https://${String(a.url).trim()}`;
          if (!/^https?:\/\//i.test(url)) return 'FAILED: only http(s) URLs are allowed';
        }
        await tabs.create(url, true);
        await new Promise((r) => setTimeout(r, 1000));
        return `opened a new tab${url ? `: ${url}` : ''}; it is now the active tab`;
      }
      case 'switch_tab': {
        tabs.activate(Number(a.tab));
        return `switched to tab ${a.tab}`;
      }
      case 'close_tab': {
        if (ctx.keepTabs?.has(Number(a.tab ?? tabs.activeId))) return 'refused: this tab was open before the task, only the user closes it';
        tabs.close(Number(a.tab ?? tabs.activeId));
        return 'closed tab';
      }
      case 'click_xy': {
        const x = Number(a.x);
        const y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'FAILED: x and y are required';
        await page.mouse.click(x, y);
        await settle(page, wc);
        return `clicked at ${x},${y}`;
      }
      case 'upload':
        return await uploadFiles(ctx, a);
      case 'list_files':
        return `files:\n${listFiles(a.dir)}`;
      case 'wait': {
        await sleep(Math.min(10, Math.max(0.5, Number(a.seconds) || 2)) * 1000);
        return 'waited';
      }
      default:
        return `FAILED: unknown action "${a.type}"`;
    }
  } catch (e) {
    return `FAILED: ${shortError(e)}`;
  }
}

module.exports = { execute, settle, normalizeKey, listFiles };

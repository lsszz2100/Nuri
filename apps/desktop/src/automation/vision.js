// Screen recognition: viewport screenshot with numbered "Set-of-Mark" labels on interactive
// elements, so a vision-capable model can say which ref (or x,y point) it means.
//
// Capture uses the app's own compositor (webContents.capturePage), which works while the window
// is covered or minimized; Playwright's page.screenshot waits for fonts/frames and could hang
// for 10s+ on editor pages. Playwright stays as a fallback.

const MAX_LABELS = 80;

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

async function drawMarks(page, marks) {
  await page
    .evaluate((marks) => {
      document.getElementById('__anb_marks')?.remove();
      const layer = document.createElement('div');
      layer.id = '__anb_marks';
      layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      for (const m of marks) {
        const b = document.createElement('div');
        b.style.cssText = `position:absolute;left:${m.x}px;top:${m.y}px;width:${m.width}px;height:${m.height}px;outline:2px solid rgba(234,88,12,.9)`;
        const t = document.createElement('div');
        t.textContent = m.ref;
        t.style.cssText = 'position:absolute;left:-2px;top:-15px;background:#ea580c;color:#fff;font:700 10px/13px monospace;padding:0 3px;border-radius:3px';
        b.appendChild(t);
        layer.appendChild(b);
      }
      document.documentElement.appendChild(layer);
    }, marks)
    .catch(() => {});
}

async function capture(page, wc) {
  if (wc && typeof wc.capturePage === 'function' && !wc.isDestroyed()) {
    try {
      const css = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      // Let the marks paint before grabbing the frame.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
      const img = await withTimeout(wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), 6000, 'capturePage');
      if (!img.isEmpty()) {
        // Scale to CSS pixels so click_xy coordinates match the screenshot.
        const scaled = img.getSize().width !== css.w ? img.resize({ width: css.w, quality: 'good' }) : img;
        return { mime: 'image/jpeg', data: scaled.toJPEG(65).toString('base64') };
      }
    } catch {
      /* fall back to Playwright */
    }
  }
  const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css', timeout: 8000, animations: 'disabled', caret: 'initial' });
  return { mime: 'image/jpeg', data: buf.toString('base64') };
}

/** Returns a labelled screenshot, or null when the page can't be captured right now. */
async function captureLabeled(page, visibleRefs = [], wc = null) {
  const marks = visibleRefs.slice(0, MAX_LABELS).map((r) => ({ ref: r.ref, ...r.box }));
  await drawMarks(page, marks);
  try {
    const shot = await capture(page, wc);
    if (process.env.ANB_DEBUG_SHOTS) {
      // Keep what the model saw, for diagnosing coordinate problems.
      const dir = require('node:path').join(require('../config').LOG_DIR, 'shots');
      require('node:fs').mkdirSync(dir, { recursive: true });
      require('node:fs').writeFileSync(require('node:path').join(dir, `${Date.now()}.jpg`), Buffer.from(shot.data, 'base64'));
    }
    return shot;
  } catch {
    return null;
  } finally {
    await page.evaluate(() => document.getElementById('__anb_marks')?.remove()).catch(() => {});
  }
}

module.exports = { captureLabeled };

#!/usr/bin/env node
/**
 * End-to-end check for BS Closer's heuristic (step 3b).
 *
 *   cd tests/e2e && npm install && npx playwright install chromium
 *   npm test
 *
 * Copies the extension to a temp folder twice, once with HEURISTIC_MODE 'log' and
 * once with 'act', loads each copy into Playwright's Chromium, and opens every
 * fixture from a local HTTP server. In log mode it asserts on the console lines
 * (verdict and score); in act mode on whether the popup is still on screen.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const FIXTURES = join(HERE, 'fixtures');
const WAIT_MS = 7000; // popups appear at 3.5 s; leaves room for the hide delay

// log: 'close' = "would close" line · 'keep' = scored below the act score · 'none' = never scored
//      'user' = left alone as user-opened
// act: 'gone' = no longer on screen · 'visible' = still on screen
const CASES = [
  { page: 'newsletter.html', target: 'sc-nl7f2a', log: 'close', act: 'gone' },
  { page: 'promo-bar.html', target: 'css-pb5', log: 'close', act: 'gone' },
  { page: 'app-sheet.html', target: 'css-ap0z', log: 'close', act: 'gone' },
  { page: 'chat.html', target: 'css-tz4', log: 'close', act: 'gone' },
  { page: 'chat.html', target: 'css-ln2', log: 'keep', act: 'visible' },
  { page: 'sticky-header.html', target: 'css-hd31', log: 'keep', act: 'visible' },
  { page: 'search-overlay.html', target: 'css-se8u', log: 'keep', act: 'visible' },
  { page: 'mini-player.html', target: 'css-mp7', log: 'keep', act: 'visible' },
  { page: 'toast.html', target: 'css-ts3', log: 'keep', act: 'visible' },
  { page: 'cookie-banner.html', target: 'css-ck9q', log: 'none', act: 'visible' },
  { page: 'user-dialog.html', target: 'sc-ud1', log: 'user', act: 'visible', click: '#open' },
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const file = join(FIXTURES, new URL(req.url, 'http://x').pathname.replace(/^\/+/, ''));
      if (!file.startsWith(FIXTURES)) throw new Error('outside fixtures');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'text/plain' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/** A copy of the extension with the given heuristic mode and logging on. */
async function extensionCopy(mode) {
  const dir = await mkdtemp(join(tmpdir(), `bs-closer-${mode}-`));
  for (const f of ['manifest.json', 'content.js', 'styles.css', 'vendor']) {
    await cp(join(ROOT, f), join(dir, f), { recursive: true });
  }
  const js = (await readFile(join(dir, 'content.js'), 'utf8'))
    .replace(/\bHEURISTIC_MODE: '\w+'/, `HEURISTIC_MODE: '${mode}'`)
    .replace(/DEBUG: \w+/, 'DEBUG: true');
  await writeFile(join(dir, 'content.js'), js);
  return dir;
}

async function runMode(mode, base) {
  const ext = await extensionCopy(mode);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // new headless mode, which supports extensions
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const pages = [...new Set(CASES.map((c) => c.page))];
  const results = await Promise.all(pages.map(async (name) => {
    const page = await context.newPage();
    const lines = [];
    page.on('console', (msg) => { if (msg.text().includes('[BS Closer]')) lines.push(msg.text()); });
    await page.goto(`${base}/${name}`);
    for (const c of CASES) if (c.page === name && c.click) await page.click(c.click, { delay: 500 });
    await page.waitForTimeout(WAIT_MS);
    const onScreen = {};
    for (const c of CASES.filter((x) => x.page === name)) {
      onScreen[c.target] = await page.evaluate((cls) => {
        const el = document.querySelector(`.${cls}`);
        return !!el && el.checkVisibility() && !el.closest('[data-bs-closer-hidden]');
      }, c.target);
    }
    await page.close();
    return [name, { lines, onScreen }];
  }));
  await context.close();
  await rm(ext, { recursive: true, force: true });
  return Object.fromEntries(results);
}

function checkLog(c, lines) {
  const mine = lines.filter((l) => l.includes(`.${c.target}`));
  const verdict = mine.map((l) => l.match(/Heuristic (would close|suspect|ignored) \(score (-?\d+)\)/)).filter(Boolean).at(-1);
  const got = verdict ? `${verdict[1]} (${verdict[2]})` : mine.some((l) => l.includes('user-opened')) ? 'user-opened' : 'no line';
  const pass = {
    close: verdict?.[1] === 'would close',
    keep: !!verdict && verdict[1] !== 'would close',
    none: !verdict,
    user: !verdict && got === 'user-opened',
  }[c.log];
  return { pass, got };
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
let failures = 0;
try {
  const [logRun, actRun] = [await runMode('log', base), await runMode('act', base)];
  for (const c of CASES) {
    const log = checkLog(c, logRun[c.page].lines);
    const visible = actRun[c.page].onScreen[c.target];
    const actPass = (c.act === 'visible') === visible;
    if (!log.pass || !actPass) failures++;
    console.log(
      `${log.pass && actPass ? 'PASS' : 'FAIL'}  ${c.page.padEnd(20)} .${c.target.padEnd(10)}`
      + ` log: ${log.got.padEnd(18)} (want ${c.log})   act: ${visible ? 'visible' : 'gone'} (want ${c.act})`,
    );
  }
  if (failures || process.argv.includes('--verbose')) {
    for (const [name, { lines }] of Object.entries(logRun)) {
      console.log(`\n--- ${name} (log mode)\n${lines.join('\n')}`);
    }
  }
} finally {
  server.close();
}
console.log(failures ? `\n${failures} failing case(s).` : '\nAll cases pass.');
process.exit(failures ? 1 : 0);

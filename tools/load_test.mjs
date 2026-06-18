import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8080';
const TIMEOUT_MS = 60000;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const logs = [];
page.on('console', (msg) => {
  logs.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => {
  logs.push(`[pageerror] ${err.message}`);
});
page.on('requestfailed', (req) => {
  logs.push(`[fail] ${req.url()} — ${req.failure()?.errorText}`);
});

console.log('Opening', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

const start = Date.now();
let lastStatus = '';
let beginVisible = false;

while (Date.now() - start < TIMEOUT_MS) {
  const state = await page.evaluate(() => ({
    bar: document.querySelector('#bar > div')?.style?.width || '0',
    status: document.getElementById('loadStatus')?.textContent || '',
    begin: document.getElementById('begin')?.classList.contains('show') || false,
    beginText: document.getElementById('begin')?.textContent || '',
  }));

  if (state.status !== lastStatus) {
    console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] bar=${state.bar} status="${state.status}" begin=${state.begin}`);
    lastStatus = state.status;
  }

  if (state.begin && !beginVisible) {
    beginVisible = true;
    console.log(`BEGIN visible after ${((Date.now() - start) / 1000).toFixed(1)}s`);
    break;
  }

  await page.waitForTimeout(500);
}

if (!beginVisible) {
  console.log('TIMEOUT — BEGIN never appeared');
}

console.log('\n--- Console (last 40) ---');
logs.slice(-40).forEach((l) => console.log(l));

await browser.close();
process.exit(beginVisible ? 0 : 1);

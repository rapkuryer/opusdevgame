import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8080';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for BEGIN
for (let i = 0; i < 40; i++) {
  const show = await page.evaluate(() => document.getElementById('begin')?.classList.contains('show'));
  if (show) break;
  await page.waitForTimeout(500);
}

await page.click('#begin');
await page.waitForTimeout(3000);

const state = await page.evaluate(() => {
  const planet = window.__abetoPlanet;
  const player = window.__player;
  if (!planet) return { error: 'no planet' };
  const chunks = planet.chunkMeshes || [];
  const visible = chunks.filter((m) => m.visible).length;
  const progresses = (planet.group?.children || [])
    .filter((c) => c.name?.startsWith('terrain'))
    .map((m) => ({
      name: m.name,
      visible: m.visible,
      scale: m.scale?.x,
      prog: m.material?.uniforms?.uAssemblyProgress?.value,
      opacity: m.material?.uniforms?.uAssemblyOpacity?.value,
    }));
  return {
    playerPos: player?.position?.toArray?.().map((n) => +n.toFixed(2)),
    waveActive: planet.materializationWave?.active,
    waveRadius: planet.materializationWave?.radius,
    chunkCount: chunks.length,
    visibleChunks: visible,
    terrainSamples: progresses.slice(0, 5),
    groupVisible: planet.group?.visible,
    groupChildren: planet.group?.children?.length,
  };
});

console.log(JSON.stringify(state, null, 2));
console.log('\n--- errors ---');
logs.filter((l) => l.includes('error') || l.includes('Shader') || l.includes('pageerror')).forEach((l) => console.log(l));

await browser.close();

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer as createViteServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const repoRoot = process.cwd();
const defaultGlb = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'grimoire',
  'hero-poses',
  'infernus_pak65_dir_vpk',
  'model.glb'
);
const glbPath = process.env.INFERNO_GLB || defaultGlb;
const artifactDir = path.join(repoRoot, 'tools', 'artifacts');

function findChromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

if (!fs.existsSync(glbPath)) {
  console.error(`Missing Infernus GLB: ${glbPath}`);
  process.exit(1);
}

fs.mkdirSync(artifactDir, { recursive: true });

const vite = await createViteServer({
  root: repoRoot,
  appType: 'spa',
  logLevel: 'error',
  server: {
    middlewareMode: true,
    hmr: false,
  },
});

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/__inferno/model.glb')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(glbPath).pipe(res);
    return;
  }
  vite.middlewares(req, res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

async function capture(page, label, pulse) {
  const tattooOnly = process.env.INFERNO_TATTOO_ONLY ?? '1';
  const onlyMaterial = process.env.INFERNO_ONLY_MATERIAL
    ? `&onlyMaterial=${encodeURIComponent(process.env.INFERNO_ONLY_MATERIAL)}`
    : '';
  const debugMode = process.env.INFERNO_DEBUG_MODE
    ? `&debugMode=${encodeURIComponent(process.env.INFERNO_DEBUG_MODE)}`
    : '';
  const maskLow = process.env.INFERNO_MASK_LOW ? `&maskLow=${encodeURIComponent(process.env.INFERNO_MASK_LOW)}` : '';
  const maskHigh = process.env.INFERNO_MASK_HIGH
    ? `&maskHigh=${encodeURIComponent(process.env.INFERNO_MASK_HIGH)}`
    : '';
  const selfIllumScale = process.env.INFERNO_SELF_ILLUM_SCALE
    ? `&selfIllumScale=${encodeURIComponent(process.env.INFERNO_SELF_ILLUM_SCALE)}`
    : '';
  const selfIllumCap = process.env.INFERNO_SELF_ILLUM_CAP
    ? `&selfIllumCap=${encodeURIComponent(process.env.INFERNO_SELF_ILLUM_CAP)}`
    : '';
  const disableBodySelfIllum = process.env.INFERNO_DISABLE_BODY_SELF_ILLUM === '1' ? '&disableBodySelfIllum=1' : '';
  const focus = process.env.INFERNO_FOCUS ? `&focus=${encodeURIComponent(process.env.INFERNO_FOCUS)}` : '';
  const cameraDir = process.env.INFERNO_CAMERA_DIR
    ? `&cameraDir=${encodeURIComponent(process.env.INFERNO_CAMERA_DIR)}`
    : '';
  const url =
    `http://127.0.0.1:${port}/tools/inferno-pulse-testbed.html` +
    `?glb=/__inferno/model.glb&tattooOnly=${tattooOnly}&capturePulse=${pulse}${onlyMaterial}${debugMode}${maskLow}${maskHigh}${selfIllumScale}${selfIllumCap}${disableBodySelfIllum}${focus}${cameraDir}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__infernoCaptureReady === true, null, {
    timeout: 120000,
  });
  const result = await page.evaluate(() => window.__infernoPulseResult);
  const suffix = process.env.INFERNO_ONLY_MATERIAL
    ? `-${process.env.INFERNO_ONLY_MATERIAL.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
    : '';
  const debugSuffix = process.env.INFERNO_DEBUG_MODE
    ? `-${process.env.INFERNO_DEBUG_MODE.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
    : '';
  const focusSuffix = process.env.INFERNO_CAMERA_DIR ? `-dir${process.env.INFERNO_CAMERA_DIR}` : '';
  await page.evaluate(() => {
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
  });
  const file = path.join(artifactDir, `inferno-tattoos-${label}-illum${suffix}${debugSuffix}${focusSuffix}.png`);
  await page.locator('#stage').screenshot({ path: file });
  return { label, pulse, file, result };
}

let browser;
try {
  const executablePath = findChromiumExecutable();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-gpu-sandbox', '--use-angle=default'],
  });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const low = await capture(page, 'low', 0);
  const high = await capture(page, 'high', 1);
  console.log(JSON.stringify({ glbPath, low, high }, null, 2));
  if (!low.result?.pass || !high.result?.pass) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await vite.close();
  await new Promise((resolve) => server.close(resolve));
}

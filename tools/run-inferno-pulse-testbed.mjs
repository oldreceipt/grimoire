import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer as createViteServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const repoRoot = process.cwd();
const defaultGlb = path.join(os.homedir(), 'AppData', 'Roaming', 'grimoire', 'hero-poses', 'infernus_pak65_dir_vpk', 'model.glb');
const glbPath = process.env.INFERNO_GLB || defaultGlb;

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

const vite = await createViteServer({
  root: repoRoot,
  appType: 'spa',
  logLevel: 'error',
  server: {
    middlewareMode: true,
    hmr: false,
  },
});

function serveInfernoGlb(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(glbPath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/__inferno/model.glb')) {
    serveInfernoGlb(res);
    return;
  }
  vite.middlewares(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const url = `http://127.0.0.1:${port}/tools/inferno-pulse-testbed.html?glb=/__inferno/model.glb`;

let browser;
try {
  const executablePath = findChromiumExecutable();
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-gpu-sandbox', '--use-angle=default'],
  });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('console', (msg) => {
    const text = msg.text();
    if (/\[SI |\[source2|\[HeroPoseViewer/.test(text)) console.log(text);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__infernoPulseDone === true, null, { timeout: 120000 });
  const result = await page.evaluate(() => window.__infernoPulseResult);
  console.log(JSON.stringify(result, null, 2));
  if (!result?.pass) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await vite.close();
  await new Promise((resolve) => server.close(resolve));
}

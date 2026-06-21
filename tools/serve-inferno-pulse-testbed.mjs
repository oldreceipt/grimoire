import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';

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

if (!fs.existsSync(glbPath)) {
  console.error(`Missing Infernus GLB: ${glbPath}`);
  process.exit(1);
}

const vite = await createViteServer({
  root: repoRoot,
  appType: 'spa',
  logLevel: 'info',
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

const port = Number(process.env.PORT || 8788);
server.listen(port, '127.0.0.1', () => {
  console.log(`Serving Infernus pulse testbed:`);
  console.log(`http://127.0.0.1:${port}/tools/inferno-pulse-testbed.html?glb=/__inferno/model.glb`);
  console.log(`GLB: ${glbPath}`);
});

async function shutdown() {
  await vite.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

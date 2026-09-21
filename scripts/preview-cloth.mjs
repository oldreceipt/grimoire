// Local Seven preview. Game assets stay in the ignored .codex-run directory.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.codex-run/source2-physics/seven');
const entry = 'models/heroes_staging/gigawatt_prisoner/gigawatt_prisoner.vmdl_c';
const gameArgument = process.argv.indexOf('--game');
const settingsPath = process.env.APPDATA && join(process.env.APPDATA, 'grimoire/settings.json');
const savedGame = settingsPath && existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, 'utf8')).deadlockPath : null;
const game = gameArgument >= 0 ? process.argv[gameArgument + 1] : savedGame;
if (!game) throw new Error('Pass --game <Deadlock directory>.');
const pak = resolve(game, 'game/citadel/pak01_dir.vpk');
const binaries = {
  'win32-x64': 'vpkmerge-windows-x86_64.exe',
  'linux-x64': 'vpkmerge-linux-x86_64',
  'darwin-arm64': 'vpkmerge-macos-aarch64',
};
const binary = binaries[`${process.platform}-${process.arch}`];
const exporter = process.env.VPKMERGE_PATH || (binary && join(root, 'resources/vpkmerge', binary));
if (!exporter || !existsSync(exporter)) throw new Error('Run pnpm fetch-vpkmerge or set VPKMERGE_PATH.');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (args) => {
  const result = spawnSync(exporter, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || 'vpkmerge export failed');
  return result.stdout;
};
mkdirSync(output, { recursive: true });
const select = ['--vpk', pak, '--entry', entry];
const clips = ['primary_stand_idle', 'primary_run_n', 'primary_run_e'];
console.log('Exporting Seven from the installed base VPK...');
writeFileSync(join(output, 'cloth.json'), run(['model', 'femodel', ...select]));
writeFileSync(join(output, 'clips.json'), run(['model', 'clips', ...select, '--json']));
run(['model', 'export', ...select, ...clips.flatMap((clip) => ['--clip', clip]), '--out', join(output, 'model.glb')]);
writeFileSync(join(output, 'metadata.json'), JSON.stringify({
  exportedAt: new Date().toISOString(), entry, clips, exporter: run(['--version']).trim(),
  vpk: { path: pak, modified: statSync(pak).mtime.toISOString(), directorySha256: sha256(pak) },
  files: Object.fromEntries(['model.glb', 'cloth.json'].map((name) => [name, sha256(join(output, name))])),
}, null, 2) + '\n');
const server = await createServer({
  configFile: false, root, publicDir: false,
  server: { host: '127.0.0.1', port: 5176, strictPort: true, watch: { ignored: ['**/.codex-run/**', '**/.flatpak-builder/**'] } },
});
await server.listen();
console.log('Seven cloth preview: http://127.0.0.1:5176/cloth-preview.html');

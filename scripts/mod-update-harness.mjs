#!/usr/bin/env node
/**
 * Disposable, deterministic update UI harness.
 *
 * Everything it creates lives below a fresh OS temp directory (or an explicit
 * --root). The Electron process receives both --user-data-dir and the harness
 * root, and settings point exclusively at the dummy Developer Mode tree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_SCENARIOS = new Set([
  'update-available',
  'preparing',
  'slow',
  'paused',
  'downloading',
  'failed',
  'network',
  '404',
  'cancelled',
  'corrupt',
  'extraction',
  'ambiguous',
  'multi-vpk',
  'success',
  'updated',
  'mixed',
]);

function parseArgs(argv) {
  const options = { scenario: 'mixed', seedOnly: false, root: null, screenshot: null };
  for (const arg of argv) {
    if (arg === '--seed-only') options.seedOnly = true;
    else if (arg.startsWith('--scenario=')) options.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--root=')) options.root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--screenshot=')) options.screenshot = resolve(arg.slice('--screenshot='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run dev:update-harness -- [--scenario=mixed] [--seed-only] [--root=/tmp/grimoire-harness] [--screenshot=/tmp/update.png]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!ALLOWED_SCENARIOS.has(options.scenario)) {
    throw new Error(`Unknown scenario "${options.scenario}". Expected one of: ${[...ALLOWED_SCENARIOS].join(', ')}`);
  }
  return options;
}

/** A tiny valid VPK v1 directory with one inline tree entry. */
function minimalVpk(entryName = 'fixture', payload = 'fixture-data') {
  const strings = Buffer.from(`txt\0scripts\0${entryName}\0`, 'utf8');
  const entry = Buffer.alloc(18);
  entry.writeUInt16LE(0x7fff, 6); // data lives in the directory VPK
  entry.writeUInt32LE(Buffer.byteLength(payload), 12);
  entry.writeUInt16LE(0xffff, 16);
  const tree = Buffer.concat([strings, entry, Buffer.from([0, 0, 0])]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);
  return Buffer.concat([header, tree, Buffer.from(payload)]);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedHarness(root, scenario) {
  const userData = ensureDir(join(root, 'user-data'));
  const deadlock = ensureDir(join(root, 'dev-deadlock'));
  const addons = ensureDir(join(deadlock, 'game', 'citadel', 'addons'));
  const disabled = ensureDir(join(addons, '.disabled'));
  const fixtures = ensureDir(join(root, 'fixtures'));
  writeFileSync(join(deadlock, 'game', 'citadel', 'gameinfo.gi'), 'GameInfo { game "Deadlock Harness" }\n');

  const installed = [
    { file: 'pak01_anchor_dir.vpk', id: 7101, gb: 6101, name: 'Anchored Update', enabled: true },
    { file: 'pak02_slow_dir.vpk', id: 7102, gb: 6102, name: 'Slow Download', enabled: true },
    { file: 'disabled_failure_dir.vpk', id: 7103, gb: 6103, name: 'Retained Failure', enabled: false },
    { file: 'pak04_ambiguous_dir.vpk', id: 7104, gb: 6104, name: 'Manual Choice', enabled: true },
    { file: 'pak05_multi_gold_dir.vpk', id: 7105, gb: 6105, name: 'Multi Variant', enabled: true, variant: 'Gold' },
    { file: 'multi_silver_dir.vpk', id: 7105, gb: 6105, name: 'Multi Variant', enabled: false, variant: 'Silver' },
  ];

  const metadata = {};
  for (const item of installed) {
    const target = item.enabled ? join(addons, item.file) : join(disabled, item.file);
    writeFileSync(target, minimalVpk(`installed_${item.id}_${item.variant ?? 'default'}`));
    metadata[item.file] = {
      modName: item.name,
      gameBananaId: item.gb,
      gameBananaFileId: item.id,
      sourceSection: 'Mods',
      categoryId: 1,
      sourceFileName: item.file,
      ...(item.variant ? { variantLabel: item.variant } : {}),
      ...(item.enabled ? {} : { lastPriority: 3 }),
    };
  }

  writeJson(join(userData, 'settings.json'), {
    deadlockPath: null,
    devMode: true,
    devDeadlockPath: deadlock,
    hasCompletedSetup: true,
    autoEnableDownloads: false,
    language: 'en',
  });
  writeJson(join(userData, 'mod-metadata.json'), metadata);

  const replacementPaths = {
    anchor: join(fixtures, 'anchor-replacement.vpk'),
    slow: join(fixtures, 'slow-replacement.vpk'),
    failure: join(fixtures, 'failure-replacement.vpk'),
    ambiguousA: join(fixtures, 'ambiguous-a.vpk'),
    ambiguousB: join(fixtures, 'ambiguous-b.vpk'),
    multiGold: join(fixtures, 'multi-gold.vpk'),
    multiSilver: join(fixtures, 'multi-silver.vpk'),
    corrupt: join(fixtures, 'corrupt.zip'),
  };
  for (const [name, path] of Object.entries(replacementPaths)) {
    writeFileSync(path, name === 'corrupt' ? Buffer.from('not an archive') : minimalVpk(`replacement_${name}`));
  }

  writeJson(join(root, 'scenario.json'), {
    scenario,
    userData,
    deadlock,
    installed,
    replacements: Object.fromEntries(
      Object.entries(replacementPaths).map(([key, path]) => [key, {
        path,
        fileName: basename(path),
        fileSize: key === 'corrupt' ? 14 : minimalVpk(`replacement_${key}`).length,
      }]),
    ),
    deterministicOutcomes: {
      slow: { pauseMs: 8000 },
      paused: { untilCancelled: true },
      network: { error: 'Network request failed' },
      '404': { error: 'HTTP 404' },
      cancelled: { cancelled: true },
      corrupt: { source: 'corrupt' },
      extraction: { error: 'Extraction failed' },
      ambiguous: { choices: ['ambiguousA', 'ambiguousB'] },
      'multi-vpk': { sources: ['multiGold', 'multiSilver'] },
      mixed: ['success', 'network', 'cancelled', 'ambiguous'],
    },
  });

  return { root, userData, deadlock };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const options = parseArgs(process.argv.slice(2));
const root = options.root ?? mkdtempSync(join(tmpdir(), 'grimoire-update-harness-'));
if (!isAbsolute(root)) throw new Error('Harness root must be an absolute path');
const marker = join(root, '.grimoire-update-harness');
if (existsSync(root) && readdirSync(root).length > 0 && !existsSync(marker)) {
  throw new Error(`Refusing to seed non-harness directory: ${root}`);
}
ensureDir(root);
writeFileSync(marker, 'Disposable Grimoire mod-update harness.\n', 'utf8');
const seeded = seedHarness(root, options.scenario);
console.log(`Harness seeded at ${root}`);
console.log(`Isolated user data: ${seeded.userData}`);
console.log(`Dummy Deadlock: ${seeded.deadlock}`);
if (options.screenshot) ensureDir(dirname(options.screenshot));

if (!options.seedOnly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const node = process.execPath;
  run(node, [join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GRIMOIRE_SOCIAL_BASE_URL:
        process.env.GRIMOIRE_SOCIAL_BASE_URL ?? 'https://grimoire-social.example.invalid',
    },
  });

  const electron = process.platform === 'win32'
    ? join(repoRoot, 'node_modules', '.bin', 'electron.cmd')
    : join(repoRoot, 'node_modules', '.bin', 'electron');
  const electronArgs = [join(repoRoot, 'dist', 'main', 'index.js'), `--user-data-dir=${seeded.userData}`];
  if (process.platform === 'linux') {
    if (process.getuid?.() === 0) electronArgs.push('--no-sandbox');
    // CI/VM verification commonly has no X server. Chromium's headless Ozone
    // backend still creates and paints the BrowserWindow for capturePage().
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      electronArgs.push('--headless', '--ozone-platform=headless', '--disable-gpu');
    }
  }
  run(electron, electronArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      GRIMOIRE_UPDATE_HARNESS_ROOT: root,
      GRIMOIRE_UPDATE_HARNESS_SCENARIO: options.scenario,
      ...(options.screenshot
        ? { GRIMOIRE_UPDATE_HARNESS_SCREENSHOT: options.screenshot }
        : {}),
    },
  });
}

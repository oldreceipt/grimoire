import { mkdirSync, mkdtempSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameBananaModDetails } from '../../../src/types/gamebanana';
import type { ModUpdateRequest } from '../../../src/types/modUpdate';

const harness = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
    app: { getPath: () => harness.userData },
    BrowserWindow: class BrowserWindow {
        static getAllWindows() { return []; }
    },
}));
vi.mock('@grimoire/social-types/heroes', () => ({
    inferHeroFromTitle: () => null,
}));

import { loadMetadata, saveMetadata, type ModMetadataMap } from './metadata';
import {
    cancelModUpdate,
    commitStagedUpdate,
    ModUpdateNeedsChoiceError,
    recoverInterruptedModUpdates,
    runModUpdateTransaction,
    stageModUpdate,
    type ModUpdateRecoveryJournal,
    type StagedUpdate,
} from './modUpdate';

function minimalVpk(entryName = 'fixture', payload = 'fixture-data'): Buffer {
    const strings = Buffer.from(`txt\0scripts\0${entryName}\0`, 'utf8');
    const entry = Buffer.alloc(18);
    entry.writeUInt16LE(0x7fff, 6);
    entry.writeUInt32LE(Buffer.byteLength(payload), 12);
    entry.writeUInt16LE(0xffff, 16);
    const tree = Buffer.concat([strings, entry, Buffer.from([0, 0, 0])]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x55aa1234, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(tree.length, 8);
    return Buffer.concat([header, tree, Buffer.from(payload)]);
}

function request(overrides: Partial<ModUpdateRequest> = {}): ModUpdateRequest {
    return {
        operationId: `operation-${Math.random().toString(16).slice(2)}`,
        stableKey: 'gamebanana:6101',
        displayName: 'Fixture Mod',
        gameBananaId: 6101,
        fileId: 7201,
        fileName: 'replacement.vpk',
        section: 'Mods',
        categoryId: 7,
        sources: [{
            id: 'old-id',
            metaKey: 'pak01_dir.vpk',
            fileName: 'pak01_dir.vpk',
            gameBananaFileId: 7101,
            enabled: true,
            priority: 1,
        }],
        ...overrides,
    };
}

function details(
    fileName: string,
    fileSize: number,
    overrides: Partial<GameBananaModDetails> = {},
): GameBananaModDetails {
    return {
        id: 6101,
        name: 'Fixture Mod',
        nsfw: false,
        category: { id: 7, name: 'Skins' },
        submitter: { id: 1, name: 'Fixture Author' },
        files: [{
            id: 7201,
            fileName,
            fileSize,
            downloadUrl: 'https://fixtures.invalid/replacement',
            downloadCount: 0,
            description: 'Default',
            isArchived: false,
        }],
        ...overrides,
    };
}

async function stageDirect(
    root: string,
    bytes: Buffer,
    overrides: Parameters<typeof stageModUpdate>[2] = {},
    req = request(),
) {
    const workDir = join(root, `stage-${Math.random().toString(16).slice(2)}`);
    return stageModUpdate(req, new AbortController().signal, {
        makeWorkDir: async () => {
            await fs.mkdir(workDir, { recursive: true });
            return workDir;
        },
        fetchDetails: async () => details(req.fileName, bytes.length),
        download: async (_url, destination, onProgress) => {
            await fs.writeFile(destination, bytes);
            onProgress(bytes.length, bytes.length);
        },
        isArchive: () => false,
        ...overrides,
    });
}

async function makeInstalledSandbox(
    root: string,
    rows: Array<{ fileName: string; enabled: boolean; bytes: Buffer; metadata?: ModMetadataMap[string] }>,
) {
    const deadlock = join(root, `deadlock-${Math.random().toString(16).slice(2)}`);
    const addons = join(deadlock, 'game', 'citadel', 'addons');
    const disabled = join(addons, '.disabled');
    await fs.mkdir(disabled, { recursive: true });
    const metadata: ModMetadataMap = {};
    for (const row of rows) {
        const path = join(row.enabled ? addons : disabled, row.fileName);
        await fs.writeFile(path, row.bytes);
        metadata[row.fileName] = row.metadata ?? {};
    }
    saveMetadata(metadata);
    return { deadlock, addons, disabled, metadata };
}

async function stagedUpdate(
    root: string,
    rows: Array<{ sourceMetaKey: string; sourceId?: string; fileName?: string; bytes?: Buffer; variantLabel?: string }>,
    metadata: StagedUpdate['metadata'] = {
        modName: 'Fixture Mod',
        gameBananaId: 6101,
        gameBananaFileId: 7201,
        sourceSection: 'Mods',
    },
): Promise<StagedUpdate> {
    const workDir = join(root, `staged-${Math.random().toString(16).slice(2)}`);
    await fs.mkdir(workDir, { recursive: true });
    const vpks = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const path = join(workDir, row.fileName ?? `replacement-${index}.vpk`);
        const bytes = row.bytes ?? minimalVpk(`new_${index}`);
        await fs.writeFile(path, bytes);
        vpks.push({
            path,
            fileName: row.fileName ?? `replacement-${index}.vpk`,
            sha256: `${index + 1}`.repeat(64),
            variantLabel: row.variantLabel,
            sourceMetaKey: row.sourceMetaKey,
            sourceId: row.sourceId ?? `source-${index}`,
        });
    }
    return { workDir, metadata, vpks };
}

describe('safe mod update service', () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'grimoire-mod-update-test-'));
        harness.userData = join(root, 'user-data');
        mkdirSync(harness.userData, { recursive: true });
        mkdtempSync(join(root, 'clock-'));
    });

    afterAll(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    describe('staging', () => {
        it('downloads an actual VPK, validates its directory tree, and reports progress', async () => {
            const bytes = minimalVpk('valid_direct');
            const onProgress = vi.fn();
            const staged = await stageDirect(root, bytes, { onProgress });
            expect(staged.vpks).toHaveLength(1);
            expect(staged.vpks[0]).toMatchObject({ sourceMetaKey: 'pak01_dir.vpk', sourceId: 'old-id' });
            expect(onProgress).toHaveBeenCalledWith(bytes.length, bytes.length);
            expect(await fs.readFile(staged.vpks[0].path)).toEqual(bytes);
        });

        it.each([
            ['network failure', new Error('Network request failed')],
            ['HTTP 404', new Error('HTTP 404')],
        ])('propagates an injected %s and removes staging', async (_label, failure) => {
            const workDir = join(root, `failed-stage-${Math.random().toString(16).slice(2)}`);
            await expect(stageModUpdate(request(), new AbortController().signal, {
                makeWorkDir: async () => { await fs.mkdir(workDir, { recursive: true }); return workDir; },
                fetchDetails: async () => details('replacement.vpk', 10),
                download: async () => { throw failure; },
            })).rejects.toThrow(failure.message);
            await expect(fs.stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('reports a deterministic 404 when the requested remote file disappeared', async () => {
            await expect(stageModUpdate(request(), new AbortController().signal, {
                fetchDetails: async () => ({ id: 6101, name: 'Fixture', nsfw: false, files: [] }),
            })).rejects.toThrow('HTTP 404');
        });

        it('cancels a controlled deferred download without touching the installed VPK', async () => {
            const oldPath = join(root, 'old-during-download.vpk');
            const oldBytes = minimalVpk('old_untouched');
            await fs.writeFile(oldPath, oldBytes);
            const controller = new AbortController();
            let releaseStarted!: () => void;
            const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
            const staged = stageModUpdate(request(), controller.signal, {
                fetchDetails: async () => details('replacement.vpk', 100),
                download: async (_url, destination, onProgress, signal) => {
                    await fs.writeFile(destination, Buffer.alloc(10));
                    onProgress(10, 100);
                    releaseStarted();
                    await new Promise<void>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                    });
                },
            });
            await started;
            expect(await fs.readFile(oldPath)).toEqual(oldBytes);
            controller.abort();
            await expect(staged).rejects.toMatchObject({ name: 'AbortError' });
            expect(await fs.readFile(oldPath)).toEqual(oldBytes);
        });

        it('rejects an exact file-size mismatch', async () => {
            const bytes = minimalVpk('wrong_size');
            await expect(stageDirect(root, bytes, {
                fetchDetails: async () => details('replacement.vpk', bytes.length + 1),
            })).rejects.toThrow('File-size mismatch');
        });

        it('rejects a corrupt direct VPK using the real parser', async () => {
            await expect(stageDirect(root, Buffer.from('not-a-vpk'))).rejects.toThrow('Invalid or corrupt VPK');
        });

        it('rejects unsupported non-VPK downloads', async () => {
            const bytes = Buffer.from('plain file');
            await expect(stageDirect(root, bytes, {
                fetchDetails: async () => details('replacement.exe', bytes.length),
            }, request({ fileName: 'replacement.exe' }))).rejects.toThrow('Unsupported replacement archive');
        });

        it('surfaces an injected extraction failure', async () => {
            const bytes = Buffer.from('fake archive');
            await expect(stageDirect(root, bytes, {
                fetchDetails: async () => details('replacement.zip', bytes.length),
                isArchive: () => true,
                extract: async () => { throw new Error('Extraction failed'); },
            }, request({ fileName: 'replacement.zip' }))).rejects.toThrow('Extraction failed');
        });

        it('maps multi-VPK replacements by proven labels, not candidate size/order', async () => {
            const goldPath = join(root, 'gold.vpk');
            const silverPath = join(root, 'silver.vpk');
            await fs.writeFile(goldPath, minimalVpk('gold', 'small'));
            await fs.writeFile(silverPath, minimalVpk('silver', 'a much larger silver payload'));
            const archive = Buffer.from('archive');
            const req = request({
                fileName: 'replacement.zip',
                sources: [
                    { id: 'gold-old', metaKey: 'pak01_dir.vpk', fileName: 'pak01_dir.vpk', enabled: true, priority: 1, variantLabel: 'Gold' },
                    { id: 'silver-old', metaKey: 'silver.vpk', fileName: 'silver.vpk', enabled: false, priority: 2, variantLabel: 'Silver' },
                ],
            });
            const staged = await stageDirect(root, archive, {
                fetchDetails: async () => details('replacement.zip', archive.length),
                isArchive: () => true,
                extract: async () => [
                    { path: silverPath, fileName: 'silver.vpk', archiveFolder: 'Silver' },
                    { path: goldPath, fileName: 'gold.vpk', archiveFolder: 'Gold' },
                ],
            }, req);
            expect(staged.vpks.map((vpk) => [vpk.sourceMetaKey, vpk.variantLabel])).toEqual([
                ['pak01_dir.vpk', 'Gold'],
                ['silver.vpk', 'Silver'],
            ]);
        });

        it('requires manual choice when multi-VPK identity is ambiguous', async () => {
            const a = join(root, 'ambiguous-a.vpk');
            const b = join(root, 'ambiguous-b.vpk');
            await fs.writeFile(a, minimalVpk('a'));
            await fs.writeFile(b, minimalVpk('b'));
            const archive = Buffer.from('archive');
            const req = request({
                fileName: 'replacement.zip',
                sources: [
                    { id: 'a-old', metaKey: 'a.vpk', fileName: 'a.vpk', enabled: true, priority: 1 },
                    { id: 'b-old', metaKey: 'b.vpk', fileName: 'b.vpk', enabled: false, priority: 2 },
                ],
            });
            await expect(stageDirect(root, archive, {
                fetchDetails: async () => details('replacement.zip', archive.length),
                isArchive: () => true,
                extract: async () => [
                    { path: a, fileName: 'a.vpk' },
                    { path: b, fileName: 'b.vpk' },
                ],
            }, req)).rejects.toBeInstanceOf(ModUpdateNeedsChoiceError);
        });

        it('applies an explicit one-to-one picker mapping for ambiguous installed variants', async () => {
            const a = join(root, 'mapped-a.vpk');
            const b = join(root, 'mapped-b.vpk');
            await fs.writeFile(a, minimalVpk('mapped_a'));
            await fs.writeFile(b, minimalVpk('mapped_b'));
            const archive = Buffer.from('archive');
            const req = request({
                fileName: 'replacement.zip',
                sources: [
                    { id: 'gold-old', metaKey: 'gold.vpk', fileName: 'gold.vpk', enabled: true, priority: 1, variantLabel: 'Gold' },
                    { id: 'silver-old', metaKey: 'silver.vpk', fileName: 'silver.vpk', enabled: false, priority: 2, variantLabel: 'Silver' },
                ],
            });
            const staged = await stageDirect(root, archive, {
                fetchDetails: async () => details('replacement.zip', archive.length),
                isArchive: () => true,
                extract: async () => [
                    { path: a, fileName: 'mapped-a.vpk' },
                    { path: b, fileName: 'mapped-b.vpk' },
                ],
                pick: async () => ['mapped-b.vpk', 'mapped-a.vpk'],
            }, req);

            expect(staged.vpks.map((vpk) => [vpk.sourceMetaKey, vpk.fileName])).toEqual([
                ['gold.vpk', 'mapped-b.vpk'],
                ['silver.vpk', 'mapped-a.vpk'],
            ]);
        });
    });

    describe('transaction orchestration', () => {
        it('does not call the swap while a slow stage is paused and cancellation is terminal', async () => {
            let finishStage!: (value: StagedUpdate) => void;
            const waiting = new Promise<StagedUpdate>((resolve) => { finishStage = resolve; });
            const commit = vi.fn();
            const req = request();
            const running = runModUpdateTransaction(req, null, {
                deadlockPath: join(root, 'unused'),
                stage: async () => waiting,
                commit,
            });
            expect(commit).not.toHaveBeenCalled();
            expect(cancelModUpdate(req.operationId)).toBe(true);
            finishStage(await stagedUpdate(root, [{ sourceMetaKey: 'pak01_dir.vpk' }]));
            await expect(running).resolves.toMatchObject({ status: 'cancelled' });
            expect(commit).not.toHaveBeenCalled();
        });

        it('returns needs-choice without committing', async () => {
            const commit = vi.fn();
            const req = request();
            const result = await runModUpdateTransaction(req, null, {
                deadlockPath: join(root, 'unused'),
                stage: async () => { throw new ModUpdateNeedsChoiceError(); },
                commit,
            });
            expect(result.status).toBe('needs-choice');
            expect(commit).not.toHaveBeenCalled();
        });

        it('emits phase changes and returns a failed result without throwing', async () => {
            const send = vi.fn();
            const req = request();
            const result = await runModUpdateTransaction(req, { webContents: { send } } as never, {
                stage: async () => { throw new Error('Network request failed'); },
            });
            expect(result).toMatchObject({ status: 'failed', error: 'Network request failed' });
            expect(send.mock.calls.map((call) => call[1].phase)).toEqual(['preparing', 'failed']);
        });

        it('emits one dedicated terminal completion without a generic download-complete refresh', async () => {
            const send = vi.fn();
            const req = request();
            const staged = await stagedUpdate(root, [{ sourceMetaKey: 'pak01_dir.vpk' }]);
            const result = await runModUpdateTransaction(req, { webContents: { send } } as never, {
                deadlockPath: join(root, 'unused'),
                stage: async () => staged,
                commit: async () => [{
                    id: 'replacement-id',
                    metaKey: 'pak01_dir.vpk',
                    fileName: 'pak01_dir.vpk',
                    gameBananaFileId: req.fileId,
                    enabled: true,
                }],
            });
            expect(result.status).toBe('completed');
            expect(send.mock.calls.map((call) => call[0])).toEqual([
                'mod-update-progress',
                'mod-update-progress',
                'mod-update-progress',
            ]);
            expect(send.mock.calls.map((call) => call[1].phase)).toEqual([
                'preparing',
                'installing',
                'updated',
            ]);
        });
    });

    describe('commit and recovery', () => {
        it.each([
            ['enabled', true, 'pak01_dir.vpk'],
            ['disabled', false, 'disabled-fixture_dir.vpk'],
        ] as const)('replaces an %s mod in place and preserves its state', async (_label, enabled, fileName) => {
            const oldBytes = minimalVpk(`old_${_label}`);
            const nextBytes = minimalVpk(`new_${_label}`);
            const sandbox = await makeInstalledSandbox(root, [{
                fileName,
                enabled,
                bytes: oldBytes,
                metadata: { modName: 'Old Name', gameBananaId: 6101, gameBananaFileId: 7101, lastPriority: 17 },
            }]);
            const req = request({
                sources: [{ id: 'old-id', metaKey: fileName, fileName, enabled, priority: 17, variantLabel: 'Default' }],
            });
            const staged = await stagedUpdate(root, [{ sourceMetaKey: fileName, bytes: nextBytes }]);
            const replacements = await commitStagedUpdate(sandbox.deadlock, req, staged);
            const installedPath = join(enabled ? sandbox.addons : sandbox.disabled, fileName);
            expect(await fs.readFile(installedPath)).toEqual(nextBytes);
            expect(replacements).toMatchObject([{ enabled, metaKey: fileName, variantLabel: 'Default' }]);
            expect(loadMetadata()[fileName]).toMatchObject({ gameBananaFileId: 7201, lastPriority: 17 });
        });

        it('accepts renderer-shaped identity and rejects a recycled source path', async () => {
            const fileName = 'pak01_dir.vpk';
            const oldBytes = minimalVpk('identity_old');
            const sandbox = await makeInstalledSandbox(root, [{
                fileName,
                enabled: true,
                bytes: oldBytes,
                metadata: {
                    gameBananaId: 6101,
                    gameBananaFileId: 7101,
                    sha256: 'old-sha',
                    vpkIndex: 2,
                },
            }]);
            const installedPath = join(sandbox.addons, fileName);
            const stat = await fs.stat(installedPath);
            const req = request({ sources: [{
                id: 'renderer-id',
                metaKey: fileName,
                fileName,
                gameBananaId: 6101,
                gameBananaFileId: 7101,
                sha256: 'old-sha',
                vpkIndex: 2,
                size: stat.size,
                installedAt: stat.mtime.toISOString(),
                enabled: true,
                priority: 1,
            }] });
            const staged = await stagedUpdate(root, [{ sourceMetaKey: fileName }]);

            await expect(commitStagedUpdate(sandbox.deadlock, req, staged)).resolves.toHaveLength(1);

            const recycledBytes = minimalVpk('recycled_owner');
            await fs.writeFile(installedPath, recycledBytes);
            saveMetadata({
                [fileName]: { gameBananaId: 9999, gameBananaFileId: 9998, sha256: 'other-sha' },
            });
            const secondStage = await stagedUpdate(root, [{ sourceMetaKey: fileName }]);
            await expect(commitStagedUpdate(sandbox.deadlock, req, secondStage))
                .rejects.toThrow('ownership changed');
            expect(await fs.readFile(installedPath)).toEqual(recycledBytes);
        });

        it('replaces multiple variants in source order and preserves each enabled state', async () => {
            const rows = [
                { fileName: 'pak01_dir.vpk', enabled: true, bytes: minimalVpk('old_gold'), metadata: { variantLabel: 'Gold', gameBananaId: 6101 } },
                { fileName: 'silver_dir.vpk', enabled: false, bytes: minimalVpk('old_silver'), metadata: { variantLabel: 'Silver', gameBananaId: 6101 } },
            ];
            const sandbox = await makeInstalledSandbox(root, rows);
            const req = request({ sources: [
                { id: 'gold', metaKey: rows[0].fileName, fileName: rows[0].fileName, enabled: true, priority: 1, variantLabel: 'Gold' },
                { id: 'silver', metaKey: rows[1].fileName, fileName: rows[1].fileName, enabled: false, priority: 2, variantLabel: 'Silver' },
            ] });
            const gold = minimalVpk('new_gold');
            const silver = minimalVpk('new_silver');
            const staged = await stagedUpdate(root, [
                { sourceMetaKey: rows[0].fileName, bytes: gold, variantLabel: 'Gold' },
                { sourceMetaKey: rows[1].fileName, bytes: silver, variantLabel: 'Silver' },
            ]);
            const result = await commitStagedUpdate(sandbox.deadlock, req, staged);
            expect(result.map((replacement) => [replacement.variantLabel, replacement.enabled])).toEqual([
                ['Gold', true],
                ['Silver', false],
            ]);
            expect(await fs.readFile(join(sandbox.addons, rows[0].fileName))).toEqual(gold);
            expect(await fs.readFile(join(sandbox.disabled, rows[1].fileName))).toEqual(silver);
        });

        it('restores old bytes and exact metadata when the final swap fails after backup', async () => {
            const fileName = 'pak01_dir.vpk';
            const oldBytes = minimalVpk('rollback_old');
            const originalMetadata: ModMetadataMap[string] = {
                modName: 'Old Name',
                gameBananaId: 6101,
                gameBananaFileId: 7101,
                variantLabel: 'Old Variant',
                globalType: 'hud',
            };
            const sandbox = await makeInstalledSandbox(root, [{ fileName, enabled: true, bytes: oldBytes, metadata: originalMetadata }]);
            const req = request({ sources: [{ id: 'old', metaKey: fileName, fileName, enabled: true, priority: 1, variantLabel: 'Old Variant' }] });
            const staged = await stagedUpdate(root, [{ sourceMetaKey: fileName, bytes: minimalVpk('rollback_new') }]);
            await expect(commitStagedUpdate(sandbox.deadlock, req, staged, {
                afterBackup: () => { throw new Error('Injected swap failure'); },
            })).rejects.toThrow('Injected swap failure');
            expect(await fs.readFile(join(sandbox.addons, fileName))).toEqual(oldBytes);
            expect(loadMetadata()[fileName]).toEqual(originalMetadata);
            const journalNames = await fs.readdir(join(harness.userData, 'mod-update-transactions')).catch(() => []);
            expect(journalNames).toEqual([]);
        });

        it('preserves a manually selected Sound Locker hero across replacement', async () => {
            const fileName = 'pak01_dir.vpk';
            const sandbox = await makeInstalledSandbox(root, [{
                fileName,
                enabled: true,
                bytes: minimalVpk('sound_old'),
                metadata: {
                    modName: 'Old Sound',
                    gameBananaId: 6101,
                    gameBananaFileId: 7101,
                    sourceSection: 'Sound',
                    lockerHero: 'Haze',
                    lockerHeroSource: 'manual',
                },
            }]);
            const req = request({
                section: 'Sound',
                sources: [{ id: 'sound', metaKey: fileName, fileName, enabled: true, priority: 1 }],
            });
            const staged = await stagedUpdate(root, [{ sourceMetaKey: fileName }], {
                modName: 'Updated Sound',
                gameBananaId: 6101,
                gameBananaFileId: 7201,
                sourceSection: 'Sound',
                lockerHero: 'Abrams',
                lockerHeroSource: 'download-title',
            });
            await commitStagedUpdate(sandbox.deadlock, req, staged);
            expect(loadMetadata()[fileName]).toMatchObject({
                lockerHero: 'Haze',
                lockerHeroSource: 'manual',
                sourceSection: 'Sound',
                gameBananaFileId: 7201,
            });
        });

        it('recovers an interrupted backed-up journal on the next launch', async () => {
            const directory = join(root, `recovery-${Math.random().toString(16).slice(2)}`);
            await fs.mkdir(directory, { recursive: true });
            const originalPath = join(directory, 'pak01_dir.vpk');
            const backupPath = join(directory, '.pak01.backup');
            const incomingPath = join(directory, '.pak01.incoming');
            const oldBytes = minimalVpk('recovery_old');
            await fs.writeFile(backupPath, oldBytes);
            await fs.writeFile(incomingPath, minimalVpk('recovery_new'));
            const originalMetadata: ModMetadataMap = {
                'pak01_dir.vpk': { modName: 'Original', gameBananaFileId: 7101 },
            };
            saveMetadata({ 'pak01_dir.vpk': { modName: 'Partial', gameBananaFileId: 7201 } });
            const journal: ModUpdateRecoveryJournal = {
                version: 1,
                operationId: 'recover-me',
                status: 'backed-up',
                originalMetadata,
                entries: [{ originalPath, destinationPath: originalPath, incomingPath, backupPath }],
            };
            const journalDir = join(harness.userData, 'mod-update-transactions');
            await fs.mkdir(journalDir, { recursive: true });
            await fs.writeFile(join(journalDir, 'recover-me.json'), JSON.stringify(journal));

            await recoverInterruptedModUpdates();

            expect(await fs.readFile(originalPath)).toEqual(oldBytes);
            await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(fs.stat(incomingPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(fs.stat(join(journalDir, 'recover-me.json'))).rejects.toMatchObject({ code: 'ENOENT' });
            expect(loadMetadata()).toEqual(originalMetadata);
        });
    });
});

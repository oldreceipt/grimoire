import { app, type BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { tmpdir } from 'os';
import type { GameBananaModDetails } from '../../../src/types/gamebanana';
import type {
    ModUpdateHarnessScenario,
    ModUpdateProgress,
    ModUpdateReplacement,
    ModUpdateRequest,
    ModUpdateResult,
} from '../../../src/types/modUpdate';
import { awaitMultiVpkPick, downloadFile } from './download';
import { extractArchive, isArchive, type ExtractedVpk } from './extract';
import { fetchModDetails } from './gamebanana';
import {
    getModMetadata,
    hashFileSha256,
    loadMetadata,
    saveMetadata,
    type ModMetadata,
    type ModMetadataMap,
} from './metadata';
import {
    generateModId,
    makeDisabledFileName,
    renameWithRetry,
    runExclusiveModMutation,
    scanMods,
    type Mod,
} from './mods';
import { getDisabledPath, metaKeyFor } from './deadlock';
import { getActiveDeadlockPath } from './settings';
import { getVpkLabels, parseVpkDirectory } from './vpk';

const UPDATE_EVENT = 'mod-update-progress';
const JOURNAL_DIR = 'mod-update-transactions';
const CANCELLED = 'CANCELLED_BY_USER';

export class ModUpdateNeedsChoiceError extends Error {
    readonly code = 'NEEDS_USER_CHOICE';

    constructor(message = 'The replacement contains multiple files and needs a manual choice.') {
        super(message);
        this.name = 'ModUpdateNeedsChoiceError';
    }
}

export interface StagedUpdateVpk {
    /** Absolute path in the disposable staging directory. */
    path: string;
    fileName: string;
    sha256: string;
    /** Proven archive/VPK label, when one was available. */
    variantLabel?: string;
    /** Existing source this VPK replaces. */
    sourceMetaKey: string;
    sourceId: string;
}

export interface StagedUpdate {
    workDir: string;
    metadata: ModMetadata;
    vpks: StagedUpdateVpk[];
}

export interface StageModUpdateDependencies {
    fetchDetails?: (modId: number, section: string) => Promise<GameBananaModDetails>;
    download?: (
        url: string,
        destination: string,
        onProgress: (downloaded: number, total: number) => void,
        signal: AbortSignal,
    ) => Promise<void>;
    isArchive?: (path: string) => boolean;
    extract?: (archivePath: string, destination: string) => Promise<ExtractedVpk[]>;
    /** Optional deterministic/manual picker. Null means the user deferred the choice. */
    pick?: (
        candidates: ExtractedVpk[],
        labels: Record<string, string>,
        signal: AbortSignal,
    ) => Promise<string[] | { selected: string[] } | null>;
    makeWorkDir?: () => Promise<string>;
    onDownloadStart?: () => void;
    onProgress?: (downloaded: number, total: number) => void;
}

export interface CommitStagedUpdateOptions {
    /** Test-only failpoint, invoked after every old file has been backed up. */
    afterBackup?: () => void | Promise<void>;
}

export interface ModUpdateRecoveryEntry {
    /** Missing in v1 journals written before multi-VPK extras; defaults true. */
    hadOriginal?: boolean;
    originalPath: string;
    destinationPath: string;
    incomingPath: string;
    backupPath: string;
    atimeMs?: number;
    mtimeMs?: number;
}

export interface ModUpdateRecoveryJournal {
    version: 1;
    operationId: string;
    status: 'prepared' | 'backed-up' | 'committed';
    originalMetadata: ModMetadataMap;
    /** Only these rows belong to this transaction; unrelated rows may change while staging. */
    metadataKeys?: string[];
    entries: ModUpdateRecoveryEntry[];
}

export interface RunModUpdateDependencies extends StageModUpdateDependencies {
    deadlockPath?: string;
    stage?: (
        request: ModUpdateRequest,
        signal: AbortSignal,
        dependencies?: StageModUpdateDependencies,
    ) => Promise<StagedUpdate>;
    commit?: (
        deadlockPath: string,
        request: ModUpdateRequest,
        staged: StagedUpdate,
        options?: CommitStagedUpdateOptions,
    ) => Promise<ModUpdateReplacement[]>;
    commitOptions?: CommitStagedUpdateOptions;
}

const activeOperations = new Map<string, AbortController>();
const activeStableKeys = new Map<string, string>();

function progress(
    request: ModUpdateRequest,
    mainWindow: BrowserWindow | null,
    phase: ModUpdateProgress['phase'],
    extra: Partial<ModUpdateProgress> = {},
): void {
    const event: ModUpdateProgress = {
        operationId: request.operationId,
        stableKey: request.stableKey,
        phase,
        displayName: request.displayName,
        gameBananaId: request.gameBananaId,
        fileId: request.fileId,
        ...extra,
    };
    mainWindow?.webContents.send(UPDATE_EVENT, event);
}

function abortError(): Error {
    return new Error(CANCELLED);
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError();
}

function isCancellation(error: unknown): boolean {
    return error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes(CANCELLED));
}

function cleanLabel(value: string | undefined): string | undefined {
    const cleaned = value?.trim();
    return cleaned ? cleaned : undefined;
}

function comparableLabel(value: string | undefined): string {
    return (value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripArchiveExtension(value: string): string {
    return value.replace(/\.(zip|7z|rar|vpk)$/i, '').trim();
}

function thumbnailUrl(details: GameBananaModDetails): string | undefined {
    const image = details.previewMedia?.images?.[0];
    return image ? `${image.baseUrl}/${image.file530 || image.file}` : undefined;
}

async function defaultDownload(
    url: string,
    destination: string,
    onProgress: (downloaded: number, total: number) => void,
    signal: AbortSignal,
): Promise<void> {
    await downloadFile(url, destination, onProgress, 30_000, 600_000, undefined, signal);
}

function candidateLabels(candidates: ExtractedVpk[]): Record<string, string> {
    const parsed = getVpkLabels(
        candidates.map((candidate) => ({ fileName: basename(candidate.path), absPath: candidate.path })),
    );
    const labels: Record<string, string> = {};
    for (const candidate of candidates) {
        const key = basename(candidate.path);
        const label = cleanLabel(candidate.archiveFolder) ?? cleanLabel(parsed[key]);
        if (label) labels[key] = label;
    }
    return labels;
}

async function pickReplacementVpks(
    request: ModUpdateRequest,
    candidates: ExtractedVpk[],
    labels: Record<string, string>,
    signal: AbortSignal,
    mainWindow: BrowserWindow | null,
): Promise<string[] | null> {
    const sizes: Record<string, number> = {};
    for (const candidate of candidates) {
        sizes[basename(candidate.path)] = (await fs.stat(candidate.path)).size;
    }
    const decision = await awaitMultiVpkPick(
        request.operationId,
        request.displayName,
        candidates.map((candidate) => basename(candidate.path)),
        labels,
        sizes,
        mainWindow,
        signal,
        request.sources.length > 1
            ? request.sources.map((source) => source.variantLabel ?? source.fileName)
            : undefined,
    );
    return decision?.selected ?? null;
}

function validateVpk(path: string): void {
    const entries = parseVpkDirectory(path);
    if (!entries || entries.length === 0) {
        throw new Error(`Invalid or corrupt VPK: ${basename(path)}`);
    }
}

function matchCandidatesToSources(
    request: ModUpdateRequest,
    candidates: ExtractedVpk[],
    labels: Record<string, string>,
): Array<{ candidate: ExtractedVpk; source: ModUpdateRequest['sources'][number]; label?: string }> {
    if (request.sources.length === 0) throw new Error('Update request has no installed source files');

    if (request.sources.length === 1 && candidates.length === 1) {
        const candidate = candidates[0];
        return [{ candidate, source: request.sources[0], label: labels[basename(candidate.path)] }];
    }

    // Replacing an existing multi-VPK group is safe only when every old variant
    // has a unique, proven label in the replacement. Size order is not identity.
    if (request.sources.length > 1) {
        if (candidates.length !== request.sources.length) throw new ModUpdateNeedsChoiceError();
        const unused = new Set(candidates);
        const matched: Array<{
            candidate: ExtractedVpk;
            source: ModUpdateRequest['sources'][number];
            label?: string;
        }> = [];
        for (const source of request.sources) {
            const wanted = comparableLabel(source.variantLabel);
            if (!wanted) throw new ModUpdateNeedsChoiceError();
            const hits = [...unused].filter(
                (candidate) => comparableLabel(labels[basename(candidate.path)]) === wanted,
            );
            if (hits.length !== 1) throw new ModUpdateNeedsChoiceError();
            unused.delete(hits[0]);
            matched.push({ candidate: hits[0], source, label: labels[basename(hits[0].path)] });
        }
        return matched;
    }

    throw new ModUpdateNeedsChoiceError();
}

/**
 * Download, extract and validate a replacement without mutating the installed
 * library. The caller owns `workDir` after success and must remove it.
 */
export async function stageModUpdate(
    request: ModUpdateRequest,
    signal: AbortSignal,
    dependencies: StageModUpdateDependencies = {},
): Promise<StagedUpdate> {
    const fetchDetails = dependencies.fetchDetails ?? ((id, section) =>
        fetchModDetails(id, section, { includeSubmitter: true }));
    const download = dependencies.download ?? defaultDownload;
    const archiveCheck = dependencies.isArchive ?? isArchive;
    const extract = dependencies.extract ?? extractArchive;
    const workDir = dependencies.makeWorkDir
        ? await dependencies.makeWorkDir()
        : await fs.mkdtemp(join(tmpdir(), 'grimoire-mod-update-'));

    try {
        throwIfAborted(signal);
        const details = await fetchDetails(request.gameBananaId, request.section);
        throwIfAborted(signal);
        const remote = details.files?.find((file) => file.id === request.fileId);
        if (!remote) {
            throw new Error(`HTTP 404: replacement file ${request.fileId} is no longer available`);
        }

        const downloadName = basename(remote.fileName || request.fileName || `update-${request.fileId}`);
        const downloadPath = join(workDir, downloadName);
        dependencies.onDownloadStart?.();
        await download(remote.downloadUrl, downloadPath, (downloaded, total) => {
            dependencies.onProgress?.(downloaded, total || remote.fileSize);
        }, signal);
        throwIfAborted(signal);

        const actualSize = (await fs.stat(downloadPath)).size;
        if (Number.isFinite(remote.fileSize) && remote.fileSize > 0 && actualSize !== remote.fileSize) {
            throw new Error(`File-size mismatch: expected ${remote.fileSize} bytes, received ${actualSize}`);
        }

        let candidates: ExtractedVpk[];
        if (archiveCheck(downloadPath)) {
            const extractionDir = join(workDir, 'extracted');
            await fs.mkdir(extractionDir, { recursive: true });
            candidates = await extract(downloadPath, extractionDir);
        } else if (extname(downloadName).toLowerCase() === '.vpk') {
            candidates = [{ path: downloadPath, fileName: downloadName }];
        } else {
            throw new Error(`Unsupported replacement archive: ${downloadName}`);
        }
        throwIfAborted(signal);
        if (candidates.length === 0) throw new Error('The replacement contains no VPK files');

        for (const candidate of candidates) validateVpk(candidate.path);
        const labels = candidateLabels(candidates);

        let matched: ReturnType<typeof matchCandidatesToSources>;
        try {
            matched = matchCandidatesToSources(request, candidates, labels);
        } catch (error) {
            if (!(error instanceof ModUpdateNeedsChoiceError) || !dependencies.pick) throw error;
            const raw = await dependencies.pick(candidates, labels, signal);
            const selected = Array.isArray(raw) ? raw : raw?.selected;
            if (!selected || selected.length === 0) throw error;
            if (request.sources.length > 1 && selected.length !== request.sources.length) {
                throw new ModUpdateNeedsChoiceError('Choose one replacement VPK for every installed variant.');
            }
            if (request.sources.length > 1 && new Set(selected).size !== selected.length) {
                throw new ModUpdateNeedsChoiceError('Each installed variant needs a different replacement VPK.');
            }
            const chosen = selected.map((name) =>
                candidates.find((candidate) =>
                    basename(candidate.path) === name || candidate.fileName === name || candidate.path === name));
            if (chosen.some((candidate) => !candidate)) throw new Error('The selected replacement file no longer exists');
            // In replacement-mapping mode the renderer returns one candidate
            // per installed source, in source order. Single-source installs
            // retain the existing multi-select behavior for optional siblings.
            matched = chosen.map((candidate, index) => ({
                source: request.sources[Math.min(index, request.sources.length - 1)],
                candidate: candidate!,
                label: labels[basename(candidate!.path)],
            }));
        }

        const selectedFileDescription = cleanLabel(remote.description);
        const commonMetadata: ModMetadata = {
            modName: details.name,
            author: details.submitter?.name,
            thumbnailUrl: thumbnailUrl(details),
            audioUrl: details.previewMedia?.metadata?.audioUrl,
            gameBananaId: request.gameBananaId,
            gameBananaFileId: request.fileId,
            categoryId: details.category?.id ?? request.categoryId,
            categoryName: details.category?.name,
            sourceSection: request.section,
            nsfw: details.nsfw,
            isArchived: remote.isArchived,
            fileDescription: selectedFileDescription,
            sourceFileName: stripArchiveExtension(remote.fileName),
        };

        const vpks: StagedUpdateVpk[] = [];
        for (const item of matched) {
            vpks.push({
                path: item.candidate.path,
                fileName: item.candidate.fileName,
                sha256: await hashFileSha256(item.candidate.path),
                variantLabel: cleanLabel(item.label) ?? item.source.variantLabel,
                sourceMetaKey: item.source.metaKey,
                sourceId: item.source.id,
            });
        }
        return { workDir, metadata: commonMetadata, vpks };
    } catch (error) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

function journalDirectory(): string {
    return join(app.getPath('userData'), JOURNAL_DIR);
}

function journalPath(operationId: string): string {
    return join(journalDirectory(), `${operationId}.json`);
}

async function writeJournal(journal: ModUpdateRecoveryJournal): Promise<void> {
    const directory = journalDirectory();
    await fs.mkdir(directory, { recursive: true });
    const path = journalPath(journal.operationId);
    const temp = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(journal, null, 2), 'utf8');
    await renameWithRetry(temp, path);
}

async function removeIfExists(path: string): Promise<void> {
    await fs.rm(path, { force: true }).catch(() => undefined);
}

function findCurrentSource(
    installed: Mod[],
    source: ModUpdateRequest['sources'][number],
    used: Set<string>,
): Mod {
    const byMeta = installed.find((mod) => mod.metaKey === source.metaKey && !used.has(mod.path));
    const byId = installed.find((mod) => mod.id === source.id && !used.has(mod.path));
    const current = byMeta ?? byId;
    if (!current) throw new Error(`Installed source changed or disappeared: ${source.fileName}`);
    const currentMetadata = getModMetadata(current.metaKey);
    const currentGameBananaId = currentMetadata?.gameBananaId ?? current.gameBananaId;
    const currentFileId = currentMetadata?.gameBananaFileId ?? current.gameBananaFileId;
    const currentSha256 = currentMetadata?.sha256 ?? current.sha256;
    const currentVpkIndex = currentMetadata?.vpkIndex ?? current.vpkIndex;
    if (source.gameBananaId !== undefined && currentGameBananaId !== source.gameBananaId) {
        throw new Error(`Installed source ownership changed before commit: ${source.fileName}`);
    }
    if (
        source.gameBananaFileId !== undefined &&
        source.gameBananaFileId !== currentFileId
    ) {
        throw new Error(`Installed source identity changed before commit: ${source.fileName}`);
    }
    if (source.sha256 && source.sha256 !== currentSha256) {
        throw new Error(`Installed source contents changed before commit: ${source.fileName}`);
    }
    if (source.vpkIndex !== undefined && currentVpkIndex !== source.vpkIndex) {
        throw new Error(`Installed variant identity changed before commit: ${source.fileName}`);
    }
    if (source.size !== undefined && current.size !== source.size) {
        throw new Error(`Installed source size changed before commit: ${source.fileName}`);
    }
    if (source.installedAt !== undefined && current.installedAt !== source.installedAt) {
        throw new Error(`Installed source timestamp changed before commit: ${source.fileName}`);
    }
    used.add(current.path);
    return current;
}

function replacementMetadata(
    original: ModMetadata | undefined,
    staged: StagedUpdate,
    vpk: StagedUpdateVpk,
    source: ModUpdateRequest['sources'][number],
): ModMetadata {
    // Begin with the old row so local choices survive: enabled location/priority
    // is represented by the unchanged destination path, while variant identity,
    // manual Locker hero and global classification remain sidecar data.
    const result: ModMetadata = {
        ...(original ?? {}),
        ...staged.metadata,
        sha256: vpk.sha256,
        variantLabel: original?.variantLabel ?? source.variantLabel ?? vpk.variantLabel,
        lastPriority: original?.lastPriority ?? source.priority,
        ignoreUpdates: false,
        // The bytes are new, so an old embedded-imprint status cannot be true.
        imprinted: undefined,
        imprintStale: undefined,
    };
    // Never let remote/title inference replace a deliberate Locker assignment.
    if (original?.lockerHeroSource === 'manual') {
        result.lockerHero = original.lockerHero;
        result.lockerHeroSource = original.lockerHeroSource;
    }
    // These values describe the card's relevant local grouping identity. Keep
    // an already-computed classification across a byte-for-byte replacement;
    // undefined means it has never been classified and may be inferred later.
    if (original?.globalType !== undefined) result.globalType = original.globalType;
    if (original?.globalTypeClassifierVersion !== undefined) {
        result.globalTypeClassifierVersion = original.globalTypeClassifierVersion;
    }
    return result;
}

function restoreMetadataRows(snapshot: ModMetadataMap, keys: Iterable<string>): void {
    const latest = structuredClone(loadMetadata());
    for (const key of keys) {
        if (snapshot[key] === undefined) delete latest[key];
        else latest[key] = structuredClone(snapshot[key]);
    }
    saveMetadata(latest);
}

/**
 * Perform the short final replacement under the global mod mutation lock.
 * Incoming files are first copied beside their destinations so each rename is
 * same-volume. A durable journal makes process termination recoverable too.
 */
export async function commitStagedUpdate(
    deadlockPath: string,
    request: ModUpdateRequest,
    staged: StagedUpdate,
    options: CommitStagedUpdateOptions = {},
): Promise<ModUpdateReplacement[]> {
    return runExclusiveModMutation(async () => {
        const installed = await scanMods(deadlockPath);
        const used = new Set<string>();
        const resolved = request.sources.map((source) => findCurrentSource(installed, source, used));
        if (staged.vpks.length !== resolved.length &&
            !(request.sources.length === 1 && staged.vpks.length > 1)) {
            throw new ModUpdateNeedsChoiceError('The replacement does not map one-to-one to the installed variants.');
        }

        const originalMetadata = structuredClone(loadMetadata());
        const targets: Array<{ current?: Mod; path: string; metaKey: string; fileName: string }> =
            resolved.map((current) => ({
                current,
                path: current.path,
                metaKey: current.metaKey,
                fileName: current.fileName,
            }));
        if (staged.vpks.length > resolved.length) {
            const disabledPath = getDisabledPath(deadlockPath);
            const taken = new Set(
                installed.filter((mod) => !mod.enabled).map((mod) => mod.fileName.toLowerCase()),
            );
            for (let index = resolved.length; index < staged.vpks.length; index++) {
                const vpk = staged.vpks[index];
                const fileName = makeDisabledFileName(
                    vpk.fileName,
                    taken,
                    request.displayName,
                    vpk.variantLabel,
                );
                taken.add(fileName.toLowerCase());
                const path = join(disabledPath, fileName);
                targets.push({ path, metaKey: metaKeyFor(path), fileName });
            }
        }

        const entries: ModUpdateRecoveryEntry[] = [];
        try {
        for (let index = 0; index < targets.length; index++) {
            const target = targets[index];
            const stagedVpk = staged.vpks[index];
            const source = request.sources[Math.min(index, request.sources.length - 1)];
            if (stagedVpk.sourceMetaKey !== source.metaKey) {
                throw new ModUpdateNeedsChoiceError('Replacement variant identity changed before installation.');
            }
            const token = `${request.operationId}-${index}`.replace(/[^a-zA-Z0-9_-]/g, '');
            const incomingPath = join(dirname(target.path), `.${basename(target.path)}.${token}.incoming`);
            const backupPath = join(dirname(target.path), `.${basename(target.path)}.${token}.backup`);
            const originalStat = target.current ? await fs.stat(target.path) : undefined;
            await fs.copyFile(stagedVpk.path, incomingPath);
            entries.push({
                hadOriginal: !!target.current,
                originalPath: target.path,
                destinationPath: target.path,
                incomingPath,
                backupPath,
                atimeMs: originalStat?.atimeMs,
                mtimeMs: originalStat?.mtimeMs,
            });
        }
        } catch (error) {
            for (const entry of entries) await removeIfExists(entry.incomingPath);
            throw error;
        }

        const journal: ModUpdateRecoveryJournal = {
            version: 1,
            operationId: request.operationId,
            status: 'prepared',
            originalMetadata,
            metadataKeys: [...new Set([
                ...request.sources.map((source) => source.metaKey),
                ...targets.map((target) => target.metaKey),
            ])],
            entries,
        };
        try {
            await writeJournal(journal);
        } catch (error) {
            for (const entry of entries) await removeIfExists(entry.incomingPath);
            throw error;
        }

        let metadataBeforeReplacement: ModMetadataMap | undefined;
        let metadataWasSaved = false;
        try {
            for (const entry of entries) {
                if (entry.hadOriginal) await renameWithRetry(entry.originalPath, entry.backupPath);
            }
            journal.status = 'backed-up';
            await writeJournal(journal);
            await options.afterBackup?.();

            for (const entry of entries) {
                await renameWithRetry(entry.incomingPath, entry.destinationPath);
                if (entry.hadOriginal && entry.atimeMs !== undefined && entry.mtimeMs !== undefined) {
                    await fs.utimes(entry.destinationPath, entry.atimeMs / 1000, entry.mtimeMs / 1000);
                }
            }

            // Rebase our target-row changes onto the latest sidecar map so a
            // concurrent edit to an unrelated mod is never reverted by commit.
            const nextMetadata = structuredClone(loadMetadata());
            metadataBeforeReplacement = structuredClone(nextMetadata);
            const replacements: ModUpdateReplacement[] = [];
            for (let index = 0; index < targets.length; index++) {
                const target = targets[index];
                const current = target.current;
                const source = request.sources[Math.min(index, request.sources.length - 1)];
                const vpk = staged.vpks[index];
                const nextEntryMetadata = replacementMetadata(
                    getModMetadata(source.metaKey) ?? originalMetadata[source.metaKey],
                    staged,
                    vpk,
                    source,
                );
                if (!current) nextEntryMetadata.variantLabel = vpk.variantLabel;
                nextMetadata[target.metaKey] = nextEntryMetadata;
                replacements.push({
                    id: generateModId(target.metaKey),
                    metaKey: target.metaKey,
                    fileName: target.fileName,
                    gameBananaFileId: request.fileId,
                    sha256: vpk.sha256,
                    enabled: current?.enabled ?? false,
                    variantLabel: current ? nextEntryMetadata.variantLabel ?? vpk.variantLabel : vpk.variantLabel,
                });
            }
            saveMetadata(nextMetadata);
            metadataWasSaved = true;
            journal.status = 'committed';
            await writeJournal(journal);

            let cleanupSucceeded = true;
            for (const entry of entries) {
                try {
                    await fs.rm(entry.backupPath, { force: true });
                    await fs.rm(entry.incomingPath, { force: true });
                } catch (error) {
                    cleanupSucceeded = false;
                    console.warn('[ModUpdate] Deferred committed backup cleanup:', error);
                }
            }
            if (cleanupSucceeded) await removeIfExists(journalPath(request.operationId));
            return replacements;
        } catch (error) {
            let rollbackError: unknown;
            for (const entry of [...entries].reverse()) {
                try {
                    if (entry.hadOriginal && existsSync(entry.backupPath)) {
                        await removeIfExists(entry.destinationPath);
                        await renameWithRetry(entry.backupPath, entry.originalPath);
                    } else if (!entry.hadOriginal) {
                        await removeIfExists(entry.destinationPath);
                    }
                    await removeIfExists(entry.incomingPath);
                } catch (candidateError) {
                    rollbackError ??= candidateError;
                }
            }
            if (metadataWasSaved && metadataBeforeReplacement) {
                restoreMetadataRows(
                    metadataBeforeReplacement,
                    journal.metadataKeys ?? request.sources.map((source) => source.metaKey),
                );
            }
            if (!rollbackError) await removeIfExists(journalPath(request.operationId));
            if (rollbackError) {
                throw new Error(
                    `Update failed and rollback needs startup recovery: ${String(error)}; ${String(rollbackError)}`,
                );
            }
            throw error;
        }
    });
}

export function cancelModUpdate(operationId: string): boolean {
    const controller = activeOperations.get(operationId);
    if (!controller) return false;
    controller.abort();
    return true;
}

export async function runModUpdateTransaction(
    request: ModUpdateRequest,
    mainWindow: BrowserWindow | null,
    dependencies: RunModUpdateDependencies = {},
): Promise<ModUpdateResult> {
    if (activeOperations.has(request.operationId) || activeStableKeys.has(request.stableKey)) {
        return {
            operationId: request.operationId,
            stableKey: request.stableKey,
            status: 'failed',
            error: 'An update for this mod is already running',
        };
    }
    const controller = new AbortController();
    activeOperations.set(request.operationId, controller);
    activeStableKeys.set(request.stableKey, request.operationId);
    let staged: StagedUpdate | undefined;

    try {
        progress(request, mainWindow, 'preparing');
        const stage = dependencies.stage ?? stageModUpdate;
        staged = await stage(request, controller.signal, {
            ...dependencies,
            pick: dependencies.pick ?? ((candidates, labels, signal) =>
                pickReplacementVpks(request, candidates, labels, signal, mainWindow)),
            onDownloadStart: () => {
                progress(request, mainWindow, 'downloading');
                dependencies.onDownloadStart?.();
            },
            onProgress: (downloaded, total) => {
                progress(request, mainWindow, 'downloading', { downloaded, total });
                dependencies.onProgress?.(downloaded, total);
            },
        });
        throwIfAborted(controller.signal);
        progress(request, mainWindow, 'installing');
        const deadlockPath = dependencies.deadlockPath ?? getActiveDeadlockPath();
        if (!deadlockPath) throw new Error('No Deadlock path configured');
        const commit = dependencies.commit ?? commitStagedUpdate;
        const replacements = await commit(deadlockPath, request, staged, dependencies.commitOptions);
        progress(request, mainWindow, 'updated');
        return {
            operationId: request.operationId,
            stableKey: request.stableKey,
            status: 'completed',
            replacements,
        };
    } catch (error) {
        if (error instanceof ModUpdateNeedsChoiceError ||
            (error instanceof Error && error.message.includes('NEEDS_USER_CHOICE'))) {
            progress(request, mainWindow, 'needs-choice', { message: error.message });
            return {
                operationId: request.operationId,
                stableKey: request.stableKey,
                status: 'needs-choice',
                error: error.message,
            };
        }
        if (isCancellation(error) || controller.signal.aborted) {
            progress(request, mainWindow, 'cancelled', { message: 'Update cancelled' });
            return { operationId: request.operationId, stableKey: request.stableKey, status: 'cancelled' };
        }
        const message = error instanceof Error ? error.message : String(error);
        progress(request, mainWindow, 'failed', { message });
        return {
            operationId: request.operationId,
            stableKey: request.stableKey,
            status: 'failed',
            error: message,
        };
    } finally {
        if (staged) await fs.rm(staged.workDir, { recursive: true, force: true }).catch(() => undefined);
        activeOperations.delete(request.operationId);
        if (activeStableKeys.get(request.stableKey) === request.operationId) {
            activeStableKeys.delete(request.stableKey);
        }
    }
}

async function recoverJournal(journal: ModUpdateRecoveryJournal, path: string): Promise<void> {
    await runExclusiveModMutation(async () => {
        if (journal.status === 'committed') {
            for (const entry of journal.entries) {
                await removeIfExists(entry.backupPath);
                await removeIfExists(entry.incomingPath);
            }
            await removeIfExists(path);
            return;
        }

        // `prepared` may still have a subset of originals moved if the process
        // stopped between individual renames, so inspect each backup rather
        // than assuming the status transition completed.
        for (const entry of [...journal.entries].reverse()) {
            if (entry.hadOriginal !== false && existsSync(entry.backupPath)) {
                await removeIfExists(entry.destinationPath);
                await renameWithRetry(entry.backupPath, entry.originalPath);
            } else if (entry.hadOriginal === false && journal.status === 'backed-up') {
                await removeIfExists(entry.destinationPath);
            }
            await removeIfExists(entry.incomingPath);
        }
        restoreMetadataRows(
            journal.originalMetadata,
            journal.metadataKeys ?? journal.entries.map((entry) => basename(entry.originalPath)),
        );
        await removeIfExists(path);
    });
}

/** Recover or finish cleanup for transactions interrupted by process exit. */
export async function recoverInterruptedModUpdates(): Promise<void> {
    const directory = journalDirectory();
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
        const path = join(directory, name);
        try {
            const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as ModUpdateRecoveryJournal;
            if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
                throw new Error('Unsupported recovery journal');
            }
            await recoverJournal(parsed, path);
        } catch (error) {
            // Retain unreadable/failed journals for diagnosis and a later retry.
            console.error(`[ModUpdate] Could not recover ${name}:`, error);
        }
    }
}

interface HarnessManifest {
    replacements: Record<string, { path: string; fileName: string; fileSize: number }>;
    deterministicOutcomes?: Record<string, unknown>;
}

function waitForHarnessPhase(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    });
}

/** Run deterministic fixtures through the real staging/commit transaction. */
export async function runModUpdateHarnessScenario(
    scenario: ModUpdateHarnessScenario,
    requests: ModUpdateRequest[],
    mainWindow: BrowserWindow | null,
): Promise<ModUpdateResult[]> {
    const root = process.env['GRIMOIRE_UPDATE_HARNESS_ROOT'];
    if (!root) throw new Error('Mod-update harness is not active');
    const manifest = JSON.parse(await fs.readFile(join(root, 'scenario.json'), 'utf8')) as HarnessManifest;
    const outcomes = scenario === 'mixed'
        ? ['success', 'network', 'cancelled', 'ambiguous']
        : requests.map(() => scenario);

    return Promise.all(requests.map(async (request, index) => {
        const outcome = outcomes[index] ?? scenario;
        const sourceKeys = outcome === 'multi-vpk'
            ? ['multiGold', 'multiSilver']
            : outcome === 'ambiguous'
                ? ['ambiguousA', 'ambiguousB']
                : [outcome === 'slow' || outcome === 'paused' || outcome === 'downloading' ? 'slow' : 'anchor'];
        const fixture = manifest.replacements[sourceKeys[0]] ?? manifest.replacements.anchor;
        const archiveLike = outcome === 'ambiguous' || outcome === 'multi-vpk' || outcome === 'corrupt' || outcome === 'extraction';
        const remoteName = archiveLike ? `${outcome}.zip` : fixture.fileName;
        const remoteSize = outcome === 'corrupt'
            ? manifest.replacements.corrupt.fileSize
            : fixture.fileSize;

        const dependencies: RunModUpdateDependencies = {
            deadlockPath: getActiveDeadlockPath() ?? join(root, 'dev-deadlock'),
            fetchDetails: async () => ({
                id: request.gameBananaId,
                name: request.displayName,
                nsfw: false,
                category: request.categoryId ? { id: request.categoryId, name: 'Harness' } : undefined,
                files: [{
                    id: request.fileId,
                    fileName: remoteName,
                    fileSize: remoteSize,
                    downloadUrl: 'https://gamebanana.com/harness',
                    downloadCount: 0,
                    isArchived: false,
                }],
            }),
            download: async (_url, destination, onProgress, signal) => {
                if (outcome === 'network' || outcome === 'failed') throw new Error('Network request failed');
                if (outcome === '404') throw new Error('HTTP 404');
                if (outcome === 'cancelled') throw abortError();
                const source = outcome === 'corrupt' ? manifest.replacements.corrupt.path : fixture.path;
                const bytes = await fs.readFile(source);
                if (outcome === 'slow' || outcome === 'downloading') {
                    const split = Math.max(1, Math.floor(bytes.length / 2));
                    await fs.writeFile(destination, bytes.subarray(0, split));
                    onProgress(split, bytes.length);
                    await waitForHarnessPhase(8_000, signal);
                    await fs.appendFile(destination, bytes.subarray(split));
                } else if (outcome === 'paused') {
                    const split = Math.max(1, Math.floor(bytes.length / 2));
                    await fs.writeFile(destination, bytes.subarray(0, split));
                    onProgress(split, bytes.length);
                    await waitForHarnessPhase(24 * 60 * 60 * 1000, signal);
                } else {
                    await fs.copyFile(source, destination);
                }
                onProgress(bytes.length, bytes.length);
            },
            isArchive: () => archiveLike,
            ...(outcome === 'ambiguous' ? { pick: async () => null } : {}),
            extract: async (_archive, destination) => {
                if (outcome === 'extraction' || outcome === 'corrupt') {
                    throw new Error(outcome === 'corrupt' ? 'Corrupt or unsupported archive' : 'Extraction failed');
                }
                const extracted: ExtractedVpk[] = [];
                for (const key of sourceKeys) {
                    const source = manifest.replacements[key];
                    const target = join(destination, source.fileName);
                    await fs.copyFile(source.path, target);
                    extracted.push({
                        path: target,
                        fileName: source.fileName,
                        archiveFolder: key.replace(/^multi/, ''),
                    });
                }
                return extracted;
            },
        };
        return runModUpdateTransaction(request, mainWindow, dependencies);
    }));
}

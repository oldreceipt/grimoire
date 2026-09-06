import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { replaceLocalVpkFile, validateReplacementVpk, replacementFileSha256, assertReplacementFileUnchanged } from './localVpkReplacement';

const directories: string[] = [];
async function fixture() {
    const directory = await fs.mkdtemp(join(tmpdir(), 'grimoire-replacement-test-'));
    directories.push(directory);
    const source = join(directory, 'new.vpk');
    const destination = join(directory, 'pak01_dir.vpk');
    await fs.writeFile(source, vpk());
    await fs.writeFile(destination, 'original');
    return { directory, source, destination };
}

function vpk(options: { version?: number; archive?: number; length?: number; terminator?: number; payload?: string; name?: string } = {}) {
    const payload = Buffer.from(options.payload ?? 'new');
    const entry = Buffer.alloc(18);
    entry.writeUInt16LE(options.archive ?? 0x7fff, 6);
    entry.writeUInt32LE(options.length ?? payload.length, 12);
    entry.writeUInt16LE(options.terminator ?? 0xffff, 16);
    const tree = Buffer.concat([Buffer.from(`txt\0 \0${options.name ?? 'asset'}\0`), entry, Buffer.from([0, 0, 0])]);
    const version = options.version ?? 2;
    const header = Buffer.alloc(version === 2 ? 28 : 12);
    header.writeUInt32LE(0x55aa1234);
    header.writeUInt32LE(version, 4);
    header.writeUInt32LE(tree.length, 8);
    if (version === 2) header.writeUInt32LE(payload.length, 12);
    return Buffer.concat([header, tree, payload]);
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('standalone replacement validation', () => {
    it.each([1, 2])('accepts a complete inline v%s VPK', async (version) => {
        const { source } = await fixture();
        await fs.writeFile(source, vpk({ version }));
        await expect(validateReplacementVpk(source)).resolves.toBeUndefined();
    });
    it.each([
        ['unsupported version', vpk({ version: 9 })],
        ['external chunks', vpk({ archive: 0 })],
        ['missing payload', vpk({ length: 100 })],
        ['invalid entry terminator', vpk({ terminator: 0 })],
        ['truncated file', vpk().subarray(0, 42)],
        ['HTML response', Buffer.from('<html>not a VPK</html>')],
    ])('rejects %s', async (_name, bytes) => {
        const { source } = await fixture();
        await fs.writeFile(source, bytes);
        await expect(validateReplacementVpk(source)).rejects.toThrow();
    });
});

describe('replacement transaction', () => {
    it('detects changed physical bytes even when the embedded original hash is unchanged', async () => {
        const { destination } = await fixture();
        const originalHash = 'a'.repeat(64);
        const payload = `AddonInfo { "originalSha256" "${originalHash}" "note" "old" }`;
        await fs.writeFile(destination, vpk({ name: 'addoninfo', payload }));
        const reviewedHash = await replacementFileSha256(destination);
        await fs.writeFile(destination, vpk({ name: 'addoninfo', payload: payload.replace('old', 'new') }));
        await expect(assertReplacementFileUnchanged(destination, reviewedHash)).rejects.toThrow('changed');
    });
    it('rechecks game state after source preparation and leaves the original in place', async () => {
        const { source, destination } = await fixture();
        let gameRunning = false;
        const commit = vi.fn();
        const rollback = vi.fn();
        await expect(replaceLocalVpkFile(source, destination, {
            validate: async (staged) => { await validateReplacementVpk(staged); gameRunning = true; },
            beforeSwap: async () => { if (gameRunning) throw new Error('Game is running'); },
            commit,
            rollback,
        })).rejects.toThrow('Game is running');
        expect(await fs.readFile(destination, 'utf8')).toBe('original');
        expect(commit).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
    });
    it('rechecks reviewed bytes after staging instead of overwriting an externally changed target', async () => {
        const { source, destination } = await fixture();
        const reviewedHash = await replacementFileSha256(destination);
        await expect(replaceLocalVpkFile(source, destination, {
            validate: async (staged) => { await validateReplacementVpk(staged); await fs.writeFile(destination, 'external edit'); },
            beforeSwap: () => assertReplacementFileUnchanged(destination, reviewedHash),
            commit: vi.fn(), rollback: vi.fn(),
        })).rejects.toThrow('changed');
        expect(await fs.readFile(destination, 'utf8')).toBe('external edit');
    });
    it('commits one VPK in the existing slot and cleans staging files', async () => {
        const { source, destination, directory } = await fixture();
        const commit = vi.fn();
        const rollback = vi.fn();
        await replaceLocalVpkFile(source, destination, { validate: validateReplacementVpk, commit, rollback });
        expect(await fs.readFile(destination)).toEqual(vpk());
        expect(commit).toHaveBeenCalledOnce();
        expect(rollback).not.toHaveBeenCalled();
        expect((await fs.readdir(directory)).sort()).toEqual(['new.vpk', 'pak01_dir.vpk']);
    });
    it('restores old bytes and metadata when profile or metadata commit fails', async () => {
        const { source, destination } = await fixture();
        let metadata = 'old';
        await expect(replaceLocalVpkFile(source, destination, {
            validate: validateReplacementVpk,
            commit: () => { metadata = 'new'; throw new Error('profile save denied'); },
            rollback: () => { metadata = 'old'; },
        })).rejects.toThrow('profile save denied');
        expect(await fs.readFile(destination, 'utf8')).toBe('original');
        expect(metadata).toBe('old');
    });
    it('never touches the original when validation or source copy fails', async () => {
        const { source, destination } = await fixture();
        const commit = vi.fn();
        const rollback = vi.fn();
        await fs.writeFile(source, 'invalid');
        await expect(replaceLocalVpkFile(source, destination, { validate: validateReplacementVpk, commit, rollback })).rejects.toThrow();
        await expect(replaceLocalVpkFile(`${source}.missing`, destination, { validate: validateReplacementVpk, commit, rollback })).rejects.toThrow();
        expect(await fs.readFile(destination, 'utf8')).toBe('original');
        expect(commit).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
    });
    it('can replace from the same source path because staging precedes the swap', async () => {
        const { source } = await fixture();
        await replaceLocalVpkFile(source, source, { validate: validateReplacementVpk, commit: () => {}, rollback: () => {} });
        expect(await fs.readFile(source)).toEqual(vpk());
    });
});

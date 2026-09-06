import { promises as fs, createReadStream } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';

export async function replacementFileSha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

export async function assertReplacementFileUnchanged(path: string, expectedFileSha256: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/i.test(expectedFileSha256) ||
        (await replacementFileSha256(path)) !== expectedFileSha256.toLowerCase()) {
        throw new Error('The installed VPK changed. Select it again before replacing it');
    }
}

/** Strict standalone-file validation before replacing a known-good install. */
export async function validateReplacementVpk(path: string): Promise<void> {
    const file = await fs.open(path, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('Select a VPK file');
        const header = Buffer.alloc(28);
        const { bytesRead } = await file.read(header, 0, 28, 0);
        const version = header.readUInt32LE(4);
        const headerSize = version === 2 ? 28 : 12;
        const treeSize = header.readUInt32LE(8);
        if (bytesRead < headerSize || header.readUInt32LE(0) !== 0x55aa1234 ||
            (version !== 1 && version !== 2) || treeSize < 1 || treeSize > 64 * 1024 * 1024 ||
            headerSize + treeSize > stat.size) throw new Error('The replacement is not a valid VPK');
        const dataSize = version === 2 ? header.readUInt32LE(12) : stat.size - headerSize - treeSize;
        const declaredSize = headerSize + treeSize + dataSize + (version === 2
            ? header.readUInt32LE(16) + header.readUInt32LE(20) + header.readUInt32LE(24) : 0);
        if (declaredSize > stat.size) throw new Error('The replacement VPK is truncated');
        const tree = Buffer.alloc(treeSize);
        if ((await file.read(tree, 0, treeSize, headerSize)).bytesRead !== treeSize) {
            throw new Error('The replacement VPK is truncated');
        }
        let offset = 0;
        let entries = 0;
        const readString = (): string => {
            const end = tree.indexOf(0, offset);
            if (end < 0) throw new Error('The replacement VPK has an incomplete directory');
            const value = tree.toString('utf8', offset, end);
            offset = end + 1;
            return value;
        };
        while (readString()) {
            while (readString()) {
                while (readString()) {
                    if (offset + 18 > tree.length) throw new Error('The replacement VPK has an incomplete entry');
                    const preload = tree.readUInt16LE(offset + 4);
                    const archive = tree.readUInt16LE(offset + 6);
                    const start = tree.readUInt32LE(offset + 8);
                    const length = tree.readUInt32LE(offset + 12);
                    if (tree.readUInt16LE(offset + 16) !== 0xffff || offset + 18 + preload > tree.length) {
                        throw new Error('The replacement VPK has an invalid entry');
                    }
                    if (length > 0 && archive !== 0x7fff) {
                        throw new Error('Replacement supports standalone VPKs only; this file needs separate archive chunks');
                    }
                    if (length > 0 && start + length > dataSize) throw new Error('The replacement VPK is missing file data');
                    offset += 18 + preload;
                    entries++;
                }
            }
        }
        if (!entries || tree.subarray(offset).some((byte) => byte !== 0)) {
            throw new Error('The replacement VPK has an invalid or empty directory');
        }
    } finally {
        await file.close();
    }
}

/** Caller holds the mod mutation lock. The original survives every failed commit. */
export async function replaceLocalVpkFile(
    source: string,
    destination: string,
    operations: {
        validate: (staged: string) => Promise<void>;
        beforeSwap?: () => Promise<void>;
        commit: () => void;
        rollback: () => void;
    },
): Promise<void> {
    const temporary = await fs.mkdtemp(join(dirname(destination), '.grimoire-replace-'));
    const staged = join(temporary, 'replacement.tmp');
    const backup = join(temporary, 'original.backup');
    let movedOriginal = false;
    let committed = false;
    let preserveBackup = false;
    try {
        await fs.copyFile(source, staged);
        await operations.validate(staged);
        await operations.beforeSwap?.();
        await fs.rename(destination, backup);
        movedOriginal = true;
        await fs.rename(staged, destination);
        operations.commit();
        committed = true;
    } catch (error) {
        if (movedOriginal) {
            const failures: string[] = [];
            try { await fs.rename(backup, destination); }
            catch (restoreError) { failures.push(String(restoreError)); preserveBackup = true; }
            try { operations.rollback(); }
            catch (restoreError) { failures.push(String(restoreError)); preserveBackup = true; }
            if (failures.length) {
                throw new Error(`${String(error)}. Recovery incomplete; check ${destination} and recovery folder ${temporary}. ${failures.join('; ')}`);
            }
        }
        throw error;
    } finally {
        if (!preserveBackup) {
            await fs.rm(temporary, { recursive: true, force: true }).catch((error) => {
                console.warn(`[mods] Replacement ${committed ? 'completed' : 'cancelled'}; temporary cleanup failed:`, error);
            });
        }
    }
}

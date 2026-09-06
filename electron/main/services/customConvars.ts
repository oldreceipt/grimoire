import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { getGameinfoPath } from './deadlock';
import type { CustomConvar, CustomConvarSettings, CustomConvarStatus } from '../../../src/types/electron';

const MARKER = 'grimoire-custom-convar';
const EMPTY: CustomConvarSettings = { entries: [], autoRestore: false };
const recoveryErrors = new Map<string, string>();

export function validateCustomConvars(input: unknown): CustomConvarSettings {
    if (!input || typeof input !== 'object') throw new Error('Invalid custom settings.');
    const value = input as CustomConvarSettings;
    if (!Array.isArray(value.entries) || value.entries.length > 100 || typeof value.autoRestore !== 'boolean') {
        throw new Error('Use at most 100 custom convars and a valid restore preference.');
    }
    const seen = new Set<string>();
    const entries = value.entries.map((entry) => {
        if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') throw new Error('Each convar needs a name and value.');
        const key = entry.key.trim().toLowerCase();
        const val = entry.value.trim();
        if (!/^[a-z_][a-z0-9_.]{0,127}$/.test(key)) throw new Error(`Invalid convar name: ${entry.key}`);
        const hasControl = [...val].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
        if (!val || val.length > 256 || hasControl || /["{}\\]/.test(val) || val.includes('//')) {
            throw new Error(`Use a single value without quotes, braces, comments or backslashes for ${key}.`);
        }
        if (seen.has(key)) throw new Error(`Duplicate convar: ${key}`);
        seen.add(key);
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`Invalid enabled setting for ${key}.`);
        return { key, value: val, enabled: entry.enabled !== false };
    });
    return { entries, autoRestore: value.autoRestore };
}

function settingsPath(deadlockPath: string): string {
    return join(dirname(getGameinfoPath(deadlockPath)), 'grimoire-custom-convars.json');
}

export function readCustomConvarSettings(deadlockPath: string): CustomConvarSettings {
    const file = settingsPath(deadlockPath);
    if (!existsSync(file)) return { ...EMPTY, entries: [] };
    return validateCustomConvars(JSON.parse(readFileSync(file, 'utf-8')));
}

function atomicWrite(file: string, content: string, expected?: string): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, content, { encoding: 'utf-8', flag: 'wx' });
        if (expected !== undefined && readFileSync(file, 'utf-8') !== expected) {
            throw new Error('The game file changed while applying. Try again when Steam has finished updating.');
        }
        renameSync(temporary, file);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

export function saveCustomConvarSettings(deadlockPath: string, input: unknown): void {
    const settings = validateCustomConvars(input);
    atomicWrite(settingsPath(deadlockPath), JSON.stringify(settings, null, 2));
}

interface Token { value: string; start: number; end: number }
interface Entry { key: Token; value?: Token; children?: Entry[]; close?: Token }

function parse(text: string): Entry[] {
    const tokens: Token[] = [];
    const re = /\s+|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|[{}]|[^\s{}"]+/gy;
    let at = 0;
    while (at < text.length) {
        re.lastIndex = at;
        const match = re.exec(text);
        if (!match) throw new Error('gameinfo.gi contains invalid syntax.');
        at = re.lastIndex;
        const raw = match[0];
        if (/^\s|^\/\//.test(raw)) continue;
        tokens.push({ value: raw.startsWith('"') ? raw.slice(1, -1) : raw, start: match.index, end: at });
    }
    let cursor = 0;
    const block = (nested: boolean): { entries: Entry[]; close?: Token } => {
        const entries: Entry[] = [];
        while (cursor < tokens.length) {
            const key = tokens[cursor++];
            if (key.value === '}') {
                if (!nested) throw new Error('gameinfo.gi has an unexpected closing brace.');
                return { entries, close: key };
            }
            const value = tokens[cursor++];
            if (key.value === '{' || !value || value.value === '}') throw new Error('gameinfo.gi is incomplete.');
            if (value.value === '{') {
                const child = block(true);
                entries.push({ key, children: child.entries, close: child.close });
            } else entries.push({ key, value });
        }
        if (nested) throw new Error('gameinfo.gi is incomplete.');
        return { entries };
    };
    return block(false).entries;
}

function convarSection(text: string): Entry {
    const roots = parse(text);
    if (roots.length !== 1 || roots[0].key.value.toLowerCase() !== 'gameinfo') throw new Error('Expected a complete GameInfo file.');
    const blocks = roots[0].children?.filter((entry) => entry.key.value.toLowerCase() === 'convars');
    if (blocks?.length !== 1 || !blocks[0].children || !blocks[0].close) throw new Error('gameinfo.gi has no unambiguous ConVars section.');
    return blocks[0];
}

export function stripCustomConvars(text: string): string {
    const clean = text.replace(/^([^\r\n]*?) \/\/ grimoire-custom-convar (added|original:([A-Za-z0-9+/=]+))(\r?\n|$)/gm, (_all, _line, kind: string, encoded: string, eol: string) => {
        if (kind === 'added') return '';
        const original = Buffer.from(encoded, 'base64').toString('utf-8');
        if (/[\r\n]/.test(original) || original.includes(MARKER)) throw new Error('A custom convar recovery marker is damaged.');
        return original + eol;
    });
    if (clean.includes(MARKER)) throw new Error('A custom convar recovery marker is damaged.');
    return clean;
}

/** Personal values are the outermost reversible layer, above any preset. */
export function layerCustomConvars(text: string, entries: CustomConvar[]): string {
    const clean = stripCustomConvars(text);
    if (!entries.length) return clean;
    const validated = validateCustomConvars({ entries, autoRestore: false }).entries.filter((entry) => entry.enabled !== false);
    if (!validated.length) return clean;
    const section = convarSection(clean);
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const additions: string[] = [];
    const eol = clean.includes('\r\n') ? '\r\n' : '\n';
    for (const entry of validated) {
        const matches = section.children!.filter((item) => item.key.value.toLowerCase() === entry.key);
        if (matches.length > 1 || matches[0]?.children) throw new Error(`The existing ${entry.key} entry is ambiguous; no changes were written.`);
        if (matches.length) {
            const match = matches[0];
            const start = clean.lastIndexOf('\n', match.key.start) + 1;
            let end = clean.indexOf('\n', match.value!.end);
            if (end < 0) end = clean.length;
            if (clean[end - 1] === '\r') end--;
            const original = clean.slice(start, end);
            const suffix = clean.slice(match.value!.end, end);
            if (clean.slice(start, match.key.start).trim() || !/^\s*(?:\/\/.*)?$/.test(suffix) || /[\r\n]/.test(original)) {
                throw new Error(`The ${entry.key} entry uses an unsupported layout; no changes were written.`);
            }
            edits.push({ start, end, text: `${clean.slice(start, match.value!.start)}"${entry.value}" // ${MARKER} original:${Buffer.from(original).toString('base64')}` });
        } else additions.push(`        ${entry.key} "${entry.value}" // ${MARKER} added${eol}`);
    }
    const insertion = clean.lastIndexOf('\n', section.close!.start) + 1;
    if (additions.length) {
        if (clean.slice(insertion, section.close!.start).trim()) throw new Error('The ConVars closing brace must be on its own line.');
        edits.push({ start: insertion, end: insertion, text: additions.join('') });
    }
    return edits.sort((a, b) => b.start - a.start).reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), clean);
}

export function getCustomConvarStatus(deadlockPath: string): CustomConvarStatus {
    const settings = readCustomConvarSettings(deadlockPath);
    try {
        const content = readFileSync(getGameinfoPath(deadlockPath), 'utf-8');
        return { settings, applied: layerCustomConvars(content, settings.entries) === content, error: recoveryErrors.get(deadlockPath) ?? null };
    } catch (error) {
        return { settings, applied: false, error: String(error) };
    }
}

export function applyCustomConvars(deadlockPath: string): CustomConvarStatus {
    const settings = readCustomConvarSettings(deadlockPath);
    const file = getGameinfoPath(deadlockPath);
    const original = readFileSync(file, 'utf-8');
    convarSection(original);
    const next = layerCustomConvars(original, settings.entries);
    if (next !== original) atomicWrite(file, next, original);
    recoveryErrors.delete(deadlockPath);
    return getCustomConvarStatus(deadlockPath);
}

/** Refuse known update states; custom/non-Steam installs have no manifest. */
function steamUpdateActive(deadlockPath: string): boolean {
    const manifest = join(dirname(dirname(deadlockPath)), 'appmanifest_1422450.acf');
    if (!existsSync(manifest)) return false;
    const content = readFileSync(manifest, 'utf-8');
    const flags = /"StateFlags"\s+"(\d+)"/.exec(content);
    return !flags || Number(flags[1]) !== 4;
}

export async function applyCustomConvarsWhenIdle(
    deadlockPath: string,
    isGameRunning: () => Promise<boolean>,
    automatic = false,
    wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 500)),
): Promise<CustomConvarStatus | null> {
    try {
        return await applyWhenIdle(deadlockPath, isGameRunning, automatic, wait);
    } catch (error) {
        if (automatic) recoveryErrors.set(deadlockPath, `Automatic restore was deferred: ${String(error)}`);
        throw error;
    }
}

async function applyWhenIdle(
    deadlockPath: string,
    isGameRunning: () => Promise<boolean>,
    automatic: boolean,
    wait: () => Promise<void>,
): Promise<CustomConvarStatus | null> {
    const settings = readCustomConvarSettings(deadlockPath);
    if (automatic && !settings.autoRestore) return null;
    if (automatic) {
        const current = getCustomConvarStatus(deadlockPath);
        if (current.applied) {
            recoveryErrors.delete(deadlockPath);
            return { ...current, error: null };
        }
    }
    return withIdleGameinfo(deadlockPath, isGameRunning, () => applyCustomConvars(deadlockPath), wait);
}

export async function withIdleGameinfo<T>(
    deadlockPath: string,
    isGameRunning: () => Promise<boolean>,
    operation: () => T,
    wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 500)),
): Promise<T> {
    const file = getGameinfoPath(deadlockPath);
    if (await isGameRunning()) throw new Error('Close Deadlock before changing gameinfo.gi.');
    if (steamUpdateActive(deadlockPath)) throw new Error('Wait for Steam to finish updating Deadlock.');
    const before = readFileSync(file, 'utf-8');
    convarSection(before);
    const modified = statSync(file).mtimeMs;
    await wait();
    if (await isGameRunning()) throw new Error('Close Deadlock before changing gameinfo.gi.');
    if (steamUpdateActive(deadlockPath) || statSync(file).mtimeMs !== modified || readFileSync(file, 'utf-8') !== before) {
        throw new Error('The game file is changing. Wait for Steam to finish, then apply again.');
    }
    return operation();
}

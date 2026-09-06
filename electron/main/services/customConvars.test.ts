import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    applyCustomConvars, applyCustomConvarsWhenIdle, getCustomConvarStatus, layerCustomConvars,
    readCustomConvarSettings, saveCustomConvarSettings, stripCustomConvars, validateCustomConvars,
} from './customConvars';
import { applyPerformanceConfig, getPerformanceConfigStatus, removePerformanceConfig, resetPerformanceConfigOverrides } from './performanceConfig';

const STOCK = readFileSync(join(__dirname, '__fixtures__/stock-gameinfo.gi'), 'utf-8').replace(/\r\n/g, '\n');
const entries = [{ key: 'r_aspectratio', value: '1.9' }, { key: 'cl_updaterate', value: '42' }];
let root: string;
let file: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grimoire-personal-'));
    mkdirSync(join(root, 'game', 'citadel'), { recursive: true });
    file = join(root, 'game', 'citadel', 'gameinfo.gi');
    writeFileSync(file, STOCK);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const read = () => readFileSync(file, 'utf-8');
const save = (autoRestore = false) => saveCustomConvarSettings(root, { entries, autoRestore });

describe('personal convar preferences', () => {
    it('saves independently of the game file, survives reset, and reports saved-but-unapplied state', () => {
        save();
        expect(read()).toBe(STOCK);
        expect(readCustomConvarSettings(root).entries[0]).toEqual({ ...entries[0], enabled: true });
        expect(getCustomConvarStatus(root).applied).toBe(false);
        applyCustomConvars(root);
        writeFileSync(file, STOCK);
        expect(readCustomConvarSettings(root).entries).toHaveLength(2);
        expect(applyCustomConvars(root).applied).toBe(true);
    });

    it.each(['x\nGameInfo', 'x" y', 'x} {', 'x\\y', '//oops', ''])('rejects unsafe value %j without changing saved preferences', (value) => {
        save();
        const before = readCustomConvarSettings(root);
        expect(() => saveCustomConvarSettings(root, { entries: [{ key: 'r_test', value }], autoRestore: false })).toThrow();
        expect(readCustomConvarSettings(root)).toEqual(before);
        expect(read()).toBe(STOCK);
    });

    it('rejects duplicate keys case-insensitively and reports failed storage', () => {
        expect(() => validateCustomConvars({ entries: [{ key: 'R_TEST', value: '1' }, { key: 'r_test', value: '2' }], autoRestore: false })).toThrow(/Duplicate/);
        mkdirSync(join(root, 'game', 'citadel', 'grimoire-custom-convars.json'));
        expect(() => save()).toThrow();
        expect(read()).toBe(STOCK);
    });
});

describe('reversible personal layer', () => {
    it.each([STOCK, STOCK.replace(/\n/g, '\r\n')])('round-trips exact bytes and applying repeatedly is idempotent', (original) => {
        const applied = layerCustomConvars(original, entries);
        expect(applied).toContain('r_aspectratio "1.9"');
        expect(layerCustomConvars(applied, entries)).toBe(applied);
        expect(stripCustomConvars(applied)).toBe(original);
        expect(layerCustomConvars(applied, [])).toBe(original);
    });

    it('overrides an existing key once and restores its original comment and value', () => {
        const original = '"GameInfo"\n{\n  "ConVars"\n  {\n    "R_ASPECTRATIO" "2.5" // player comment\n  }\n}\n';
        const result = layerCustomConvars(original, [entries[0]]);
        expect(result).toContain('"R_ASPECTRATIO" "1.9"');
        expect(stripCustomConvars(result)).toBe(original);
        expect(layerCustomConvars(result, [{ ...entries[0], enabled: false }])).toBe(original);
    });

    it('fails closed on duplicate target keys or incomplete game files', () => {
        const duplicate = 'GameInfo\n{\nConVars\n{\nr_aspectratio "1"\nR_ASPECTRATIO "2"\n}\n}\n';
        expect(() => layerCustomConvars(duplicate, entries)).toThrow(/ambiguous/);
        expect(() => layerCustomConvars('GameInfo { ConVars {', entries)).toThrow();
        expect(() => layerCustomConvars('GameInfo {}', entries)).toThrow();
    });

    it('personal values survive preset switching/reset/removal without being harvested', () => {
        save();
        applyCustomConvars(root);
        for (const presetId of ['sqooky-default', 'optilock-max']) {
            expect(applyPerformanceConfig(root, { presetId }).state).toBe('applied');
            expect(getCustomConvarStatus(root).applied).toBe(true);
            expect(getPerformanceConfigStatus(root).handEdited).toBe(false);
            expect(getPerformanceConfigStatus(root).overrideCount).toBe(0);
        }
        expect(resetPerformanceConfigOverrides(root, { presetId: 'optilock-max' }).state).toBe('applied');
        expect(getCustomConvarStatus(root).applied).toBe(true);
        expect(removePerformanceConfig(root).state).toBe('not-applied');
        expect(getCustomConvarStatus(root).applied).toBe(true);
        saveCustomConvarSettings(root, { entries: [], autoRestore: false });
        applyCustomConvars(root);
        expect(read()).toBe(STOCK);
    });
});

describe('startup and modded-launch recovery', () => {
    const idle = async () => false;
    const immediate = async () => {};
    it('requires opt-in and recovers valid reset files when enabled', async () => {
        save();
        expect(await applyCustomConvarsWhenIdle(root, idle, true, immediate)).toBeNull();
        expect(read()).toBe(STOCK);
        save(true);
        expect((await applyCustomConvarsWhenIdle(root, idle, true, immediate))?.applied).toBe(true);
        writeFileSync(file, STOCK);
        await applyCustomConvarsWhenIdle(root, idle, true, immediate);
        expect(getCustomConvarStatus(root).applied).toBe(true);
    });
    it('applies saved removal of the final row on recovery', async () => {
        save(true);
        applyCustomConvars(root);
        saveCustomConvarSettings(root, { entries: [], autoRestore: true });
        await applyCustomConvarsWhenIdle(root, idle, true, immediate);
        expect(read()).toBe(STOCK);
    });
    it('does not block launch or warn about a running game when values already match', async () => {
        save(true);
        applyCustomConvars(root);
        const before = read();
        const result = await applyCustomConvarsWhenIdle(root, async () => true, true, immediate);
        expect(result?.applied).toBe(true);
        expect(result?.error).toBeNull();
        expect(read()).toBe(before);
    });
    it('refuses a running game, a game starting during the wait, and a changing file', async () => {
        save(true);
        await expect(applyCustomConvarsWhenIdle(root, async () => true, true, immediate)).rejects.toThrow(/Close Deadlock/);
        let checks = 0;
        await expect(applyCustomConvarsWhenIdle(root, async () => ++checks > 1, true, immediate)).rejects.toThrow(/Close Deadlock/);
        await expect(applyCustomConvarsWhenIdle(root, idle, true, async () => { writeFileSync(file, STOCK + '\n'); })).rejects.toThrow(/changing/);
        expect(read()).toBe(STOCK + '\n');
    });
    it('does not replace an empty or malformed file with an old backup', async () => {
        save(true);
        writeFileSync(file + '.grimoire-bak', STOCK);
        writeFileSync(file, '');
        await expect(applyCustomConvarsWhenIdle(root, idle, true, immediate)).rejects.toThrow();
        expect(read()).toBe('');
    });
    it('refuses Steam update states before touching the file', async () => {
        const steamRoot = join(root, 'steamapps');
        const gameRoot = join(steamRoot, 'common', 'Deadlock');
        mkdirSync(join(gameRoot, 'game', 'citadel'), { recursive: true });
        const gameFile = join(gameRoot, 'game', 'citadel', 'gameinfo.gi');
        writeFileSync(gameFile, STOCK);
        saveCustomConvarSettings(gameRoot, { entries, autoRestore: true });
        const manifest = join(steamRoot, 'appmanifest_1422450.acf');
        writeFileSync(manifest, '"AppState" { "StateFlags" "1026" }');
        await expect(applyCustomConvarsWhenIdle(gameRoot, idle, true, immediate)).rejects.toThrow(/Steam/);
        expect(readFileSync(gameFile, 'utf-8')).toBe(STOCK);
        writeFileSync(manifest, '"AppState" { "StateFlags" "4" }');
        expect((await applyCustomConvarsWhenIdle(gameRoot, idle, true, immediate))?.applied).toBe(true);
    });
});

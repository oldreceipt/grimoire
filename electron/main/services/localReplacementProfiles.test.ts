import { describe, expect, it } from 'vitest';
import type { Mod } from '../../../src/types/mod';
import type { Profile, ProfileMod } from '../../../src/types/electron';
import { retargetLocalReplacementProfiles } from './localReplacementProfiles';

const oldSha = 'a'.repeat(64);
const newSha = 'b'.repeat(64);
const mod = (fileName: string, sha256 = oldSha): Mod => ({
    id: fileName, metaKey: fileName, fileName, path: `/mods/${fileName}`, name: 'Local mod',
    enabled: true, priority: 1, size: 10, installedAt: '', sha256,
});
const entry = (fileName: string, sha256: string | undefined = oldSha): ProfileMod => ({ fileName, sha256, enabled: true, priority: 1 });
const profile = (mods: ProfileMod[]): Profile => ({ id: 'p', name: 'Profile', mods, createdAt: '', updatedAt: '' });

describe('profile ownership during local replacement', () => {
    it('retargets a local mod after its slot changed without mutating the saved input', () => {
        const target = mod('pak02_dir.vpk');
        const saved = [profile([entry('pak01_dir.vpk')])];
        const updated = retargetLocalReplacementProfiles(saved, [target], () => target, target.metaKey, newSha);
        expect(updated[0].mods[0].sha256).toBe(newSha);
        expect(saved[0].mods[0].sha256).toBe(oldSha);
    });
    it('preserves an identical twin and updates only the resolved target', () => {
        const target = mod('pak01_dir.vpk');
        const twin = mod('pak02_dir.vpk');
        const mods = [target, twin];
        const updated = retargetLocalReplacementProfiles([profile([entry(twin.fileName), entry(target.fileName)])],
            mods, (key) => mods.find((m) => m.metaKey === key), target.metaKey, newSha);
        expect(updated[0].mods.map((m) => m.sha256)).toEqual([oldSha, newSha]);
    });
    it('does not retarget a different local mod that reused a saved filename', () => {
        const target = mod('pak01_dir.vpk', 'c'.repeat(64));
        const saved = [profile([entry(target.fileName)])];
        const updated = retargetLocalReplacementProfiles(saved, [target], () => target, target.metaKey, newSha);
        expect(updated[0].mods[0].sha256).toBe(oldSha);
    });
    it('upgrades a legacy filename-only profile that resolves to the target', () => {
        const target = mod('pak01_dir.vpk');
        const updated = retargetLocalReplacementProfiles([profile([{ fileName: target.fileName, enabled: false, priority: 5 }])],
            [target], () => target, target.metaKey, newSha);
        expect(updated[0].mods[0]).toMatchObject({ sha256: newSha, enabled: false, priority: 5 });
    });
});

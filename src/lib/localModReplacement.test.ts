import { describe, expect, it } from 'vitest';
import type { Mod } from '../types/mod';
import { canReplaceLocalMod, localReplacementCandidates, replacementTargetIsCurrent } from './localModReplacement';

const mod = (patch: Partial<Mod> = {}): Mod => ({
  id: 'one', name: 'Blue Ivy', fileName: 'pak01_dir.vpk', metaKey: 'pak01_dir.vpk',
  path: '/addons/pak01_dir.vpk', enabled: false, priority: 1, size: 100,
  installedAt: '', sha256: 'old-hash', ...patch,
});

describe('local replacement suggestions', () => {
  it('returns all ambiguous candidates without choosing a winner, including disabled variants', () => {
    const first = mod({ localGroupId: 'g', variantLabel: 'Blue' });
    const second = mod({ id: 'two', metaKey: 'addons2/pak01_dir.vpk', localGroupId: 'g' });
    expect(localReplacementCandidates('/download/blue_ivy.vpk', 'blue ivy', [first, second])).toEqual([first, second]);
  });

  it('uses the original source name after the installed title is renamed', () => {
    const renamed = mod({ name: 'My favorite', sourceFileName: 'blue_ivy_dir.vpk' });
    expect(localReplacementCandidates('blue_ivy.vpk', 'blue ivy', [renamed])).toEqual([renamed]);
  });

  it('does not suggest generic engine slots, archives, or fuzzy title matches', () => {
    expect(localReplacementCandidates('pak01_dir.vpk', 'pak01', [mod({ name: 'pak01' })])).toEqual([]);
    expect(localReplacementCandidates('blue_ivy.zip', 'Blue Ivy', [mod()])).toEqual([]);
    expect(localReplacementCandidates('blue_ivy_v2.vpk', 'Blue Ivy v2', [mod()])).toEqual([]);
  });

  it('excludes remotely sourced, unknown, generated and unhashed targets', () => {
    for (const patch of [{ gameBananaId: 42 }, { gameBananaFileId: 42 }, { isUnknown: true },
      { sha256: undefined }, { lockerCosmetics: { cards: [], rebuiltAt: '' } },
      { forgeInstall: { name: 'x', origin: 'https://example.com', installedAt: '' } }]) {
      expect(canReplaceLocalMod(mod(patch))).toBe(false);
    }
  });

  it('invalidates an explicitly reviewed target after content or location changes', () => {
    const target = mod();
    expect(replacementTargetIsCurrent(target, [target])).toBe(true);
    expect(replacementTargetIsCurrent(target, [mod({ sha256: 'new-hash' })])).toBe(false);
    expect(replacementTargetIsCurrent(target, [mod({ metaKey: 'pak02_dir.vpk' })])).toBe(false);
    expect(replacementTargetIsCurrent(target, [])).toBe(false);
  });
});

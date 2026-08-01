import { describe, expect, it } from 'vitest';
import type { Mod } from '../types/mod';
import { buildModEntries, stableModUpdateKey } from '../lib/installedEntries';

function mod(id: string, gameBananaId?: number, overrides: Partial<Mod> = {}): Mod {
  return {
    id,
    name: `Mod ${id}`,
    fileName: `${id}_dir.vpk`,
    path: `/fixture/${id}_dir.vpk`,
    metaKey: `${id}_dir.vpk`,
    enabled: true,
    priority: Number(id.replace(/\D/g, '')) || 1,
    size: 100,
    installedAt: '2026-01-01T00:00:00.000Z',
    gameBananaId,
    ...overrides,
  };
}

describe('Installed update card continuity', () => {
  it('keeps a one-for-one replacement at the same grid position despite a new local id', () => {
    const before = [mod('a1', 10), mod('b2', 20), mod('c3', 30)];
    const after = [mod('a1', 10), mod('new-local-id', 20), mod('c3', 30)];

    expect(buildModEntries(before).map((entry) => entry.key)).toEqual([
      'gamebanana:10',
      'gamebanana:20',
      'gamebanana:30',
    ]);
    expect(buildModEntries(after).map((entry) => entry.key)).toEqual(
      buildModEntries(before).map((entry) => entry.key),
    );
  });

  it('keeps a single-to-multi replacement at the first source occurrence', () => {
    const before = [mod('a1', 10), mod('single', 20), mod('c3', 30)];
    const after = [
      mod('a1', 10),
      mod('gold', 20, { variantLabel: 'Gold' }),
      mod('c3', 30),
      mod('silver', 20, { variantLabel: 'Silver', priority: 9 }),
    ];
    const entries = buildModEntries(after);

    expect(entries.map((entry) => entry.key)).toEqual(
      buildModEntries(before).map((entry) => entry.key),
    );
    expect(entries[1]).toMatchObject({ kind: 'group', key: 'gamebanana:20' });
    if (entries[1].kind === 'group') {
      expect(entries[1].variants.map((variant) => variant.variantLabel)).toEqual(['Gold', 'Silver']);
    }
  });

  it('does not create duplicate cards for sibling VPKs', () => {
    const entries = buildModEntries([
      mod('gold', 20, { variantLabel: 'Gold' }),
      mod('silver', 20, { variantLabel: 'Silver' }),
      mod('local'),
    ]);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  it('uses a GameBanana identity that survives filename and id replacement', () => {
    expect(stableModUpdateKey(mod('before', 20))).toBe('gamebanana:20');
    expect(stableModUpdateKey(mod('after', 20, { fileName: 'different.vpk' }))).toBe('gamebanana:20');
  });
});

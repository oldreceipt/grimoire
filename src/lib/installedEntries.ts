import type { Mod } from '../types/mod';

export type ModEntry =
  | { kind: 'single'; mod: Mod; key: string }
  | {
      kind: 'group';
      gameBananaId: number;
      variants: Mod[];
      enabledVariants: Mod[];
      active: Mod | null;
      primary: Mod;
      totalSize: number;
      key: string;
    };

function localEntryBaseKey(mod: Mod): string {
  if (mod.sha256) return `single:sha:${mod.sha256}`;
  return `single:local:${mod.name}:${mod.size}`;
}

/**
 * Build cards in the order their first physical file appeared. A GameBanana
 * card deliberately keeps the same key while changing between one and many
 * VPKs, so a replacement cannot unmount/reinsert it elsewhere in the grid.
 */
export function buildModEntries(mods: Mod[]): ModEntry[] {
  const gameBananaGroups = new Map<number, Mod[]>();
  const localKeyCounts = new Map<string, number>();

  for (const mod of mods) {
    if (typeof mod.gameBananaId === 'number' && mod.gameBananaId > 0) {
      const variants = gameBananaGroups.get(mod.gameBananaId) ?? [];
      variants.push(mod);
      gameBananaGroups.set(mod.gameBananaId, variants);
    } else {
      const base = localEntryBaseKey(mod);
      localKeyCounts.set(base, (localKeyCounts.get(base) ?? 0) + 1);
    }
  }

  const emittedGameBananaIds = new Set<number>();
  const entries: ModEntry[] = [];
  for (const mod of mods) {
    if (typeof mod.gameBananaId !== 'number' || mod.gameBananaId <= 0) {
      const base = localEntryBaseKey(mod);
      entries.push({
        kind: 'single',
        mod,
        key: (localKeyCounts.get(base) ?? 0) > 1 ? `${base}#${mod.id}` : base,
      });
      continue;
    }

    if (emittedGameBananaIds.has(mod.gameBananaId)) continue;
    emittedGameBananaIds.add(mod.gameBananaId);
    const variants = [...(gameBananaGroups.get(mod.gameBananaId) ?? [mod])]
      .sort((left, right) => left.priority - right.priority);
    const stableKey = `gamebanana:${mod.gameBananaId}`;
    if (variants.length === 1) {
      entries.push({ kind: 'single', mod: variants[0], key: stableKey });
      continue;
    }

    const enabledVariants = variants.filter((variant) => variant.enabled);
    const active = enabledVariants[0] ?? null;
    const primary = active ?? variants[0];
    entries.push({
      kind: 'group',
      gameBananaId: mod.gameBananaId,
      variants,
      enabledVariants,
      active,
      primary,
      totalSize: variants.reduce((sum, variant) => sum + variant.size, 0),
      key: stableKey,
    });
  }
  return entries;
}

export function stableModUpdateKey(mod: Pick<Mod, 'id' | 'gameBananaId'>): string {
  return typeof mod.gameBananaId === 'number' && mod.gameBananaId > 0
    ? `gamebanana:${mod.gameBananaId}`
    : `local:${mod.id}`;
}

import type { Mod } from '../types/mod';
import { deriveModNameFromPath } from './customModImport';

export function canReplaceLocalMod(mod: Mod): mod is Mod & { sha256: string } {
  if (!mod.sha256 || !mod.name.trim() || mod.isUnknown) return false;
  const metadata = mod as Mod & Record<string, unknown>;
  return ![
    'gameBananaId', 'gameBananaFileId', 'merged', 'forgeInstall',
    'lockerCosmetics', 'lockerSounds', 'lockerColors', 'lockerTrippySkins',
    'soulImport', 'urnImport', 'soundSwap',
  ].some((key) => !!metadata[key]);
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const genericName = /^(?:pak\d*(?:[ _-]dir)?|mod|custom mod|addon|untitled)$/i;

/** Names only suggest candidates. The user always chooses an installed file. */
export function localReplacementCandidates(path: string, name: string, mods: Mod[]): Mod[] {
  if (!/\.vpk$/i.test(path)) return [];
  const keys = new Set([nameKey(name), nameKey(deriveModNameFromPath(path))]
    .filter((key) => key && !genericName.test(key)));
  return mods.filter((mod) => canReplaceLocalMod(mod) && (
    keys.has(nameKey(mod.name)) ||
    (!!mod.sourceFileName && keys.has(nameKey(deriveModNameFromPath(mod.sourceFileName))))
  ));
}

export function replacementTargetIsCurrent(target: Mod, mods: Mod[]): boolean {
  return mods.some((mod) => mod.metaKey === target.metaKey &&
    mod.sha256 === target.sha256 && canReplaceLocalMod(mod));
}

import type { Profile } from '../../../src/types/electron';
import type { Mod } from '../../../src/types/mod';
import { buildProfileModResolver, type MetaLookup } from './profileResolver';

/** Follow the profile resolver's pre-replacement ownership, including identical twins. */
export function retargetLocalReplacementProfiles(
    profiles: Profile[], mods: Mod[], getMetadata: MetaLookup, targetMetaKey: string, newSha: string,
): Profile[] {
    return profiles.map((profile) => {
        const resolve = buildProfileModResolver(mods, getMetadata);
        return {
            ...profile,
            mods: profile.mods.map((entry) => resolve(entry).mod?.metaKey === targetMetaKey
                ? { ...entry, sha256: newSha }
                : entry),
        };
    });
}

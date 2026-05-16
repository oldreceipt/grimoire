import { app } from 'electron';
import { gzipSync, gunzipSync } from 'zlib';
import { addProfile, generateProfileId, loadProfiles, type Profile, type ProfileMod } from './profiles';
import { scanMods } from './mods';
import { getModMetadata } from './metadata';
import { fetchModDetails } from './gamebanana';
import type {
    PortableProfile,
    PortableModEntry,
    PortableExportResult,
    PortableResolutionReport,
    PortableResolvedMod,
} from '../../../src/types/portableProfile';
import {
    PORTABLE_PROFILE_FORMAT,
    PORTABLE_PROFILE_SCHEMA_VERSION,
    PORTABLE_PROFILE_SHARE_PREFIX,
} from '../../../src/types/portableProfile';

const DEADLOCK_STEAM_APP_ID = 1422450;
const DEADLOCK_GAMEBANANA_GAME_ID = 20948;

function base64UrlEncode(buf: Buffer): string {
    return buf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64UrlDecode(s: string): Buffer {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    return Buffer.from(pad ? padded + '='.repeat(4 - pad) : padded, 'base64');
}

export function encodeShareCode(json: string): string {
    const compressed = gzipSync(Buffer.from(json, 'utf8'));
    return PORTABLE_PROFILE_SHARE_PREFIX + base64UrlEncode(compressed);
}

export function decodeShareCode(code: string): string {
    if (!code.startsWith(PORTABLE_PROFILE_SHARE_PREFIX)) {
        throw new Error(`Share code missing "${PORTABLE_PROFILE_SHARE_PREFIX}" prefix`);
    }
    const body = code.slice(PORTABLE_PROFILE_SHARE_PREFIX.length).trim();
    const decompressed = gunzipSync(base64UrlDecode(body));
    return decompressed.toString('utf8');
}

/** Build a portable profile from a stored Grimoire profile. Local mods (no
 *  gameBananaFileId) are skipped and reported via warnings so the UI can tell
 *  the user without scanning the file again. */
export async function buildPortableProfile(
    deadlockPath: string,
    profileId: string
): Promise<PortableExportResult> {
    const profiles = loadProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);

    const installed = await scanMods(deadlockPath);
    const modByFileName = new Map(installed.map((m) => [m.fileName, m]));

    const mods: PortableModEntry[] = [];
    const warnings: string[] = [];

    for (const profileMod of profile.mods) {
        const installedMod = modByFileName.get(profileMod.fileName);
        const metadata = getModMetadata(profileMod.fileName);
        const gbId = metadata?.gameBananaId ?? installedMod?.gameBananaId;
        const fileId = metadata?.gameBananaFileId ?? installedMod?.gameBananaFileId;

        if (!gbId || !fileId) {
            const label =
                metadata?.modName ||
                installedMod?.name ||
                profileMod.fileName;
            warnings.push(`Skipped local mod: ${label}`);
            continue;
        }

        const fileLabel =
            metadata?.variantLabel ||
            metadata?.fileDescription ||
            metadata?.sourceFileName ||
            undefined;

        mods.push({
            source: 'gamebanana',
            ref: { submissionId: gbId, fileId, section: metadata?.sourceSection || 'Mod' },
            enabled: profileMod.enabled,
            priority: profileMod.priority,
            hint: {
                name: metadata?.modName || installedMod?.name,
                category: metadata?.categoryName,
                fileLabel,
                originalFileName: metadata?.sourceFileName,
                thumbnailUrl: metadata?.thumbnailUrl,
                nsfw: metadata?.nsfw,
                isArchived: metadata?.isArchived,
            },
        });
    }

    const portable: PortableProfile = {
        format: PORTABLE_PROFILE_FORMAT,
        schemaVersion: PORTABLE_PROFILE_SCHEMA_VERSION,
        game: {
            steamAppId: DEADLOCK_STEAM_APP_ID,
            gameBananaGameId: DEADLOCK_GAMEBANANA_GAME_ID,
            name: 'Deadlock',
        },
        exportedAt: new Date().toISOString(),
        exportedBy: { tool: 'grimoire', version: app.getVersion() },
        profile: { name: profile.name },
        mods,
        extensions:
            profile.crosshair || (profile.autoexecCommands && profile.autoexecCommands.length > 0)
                ? {
                      grimoire: {
                          crosshair: profile.crosshair,
                          autoexecCommands: profile.autoexecCommands,
                      },
                  }
                : undefined,
    };

    const json = JSON.stringify(portable, null, 2);
    const shareCode = encodeShareCode(json);

    return { profile: portable, json, shareCode, warnings };
}

/** Validate a parsed object as a v1 portable profile. Throws with a useful
 *  message on failure so the import UI can show it verbatim. Untrusted input:
 *  we treat the entire payload as hostile until validated. */
function validatePortable(obj: unknown): PortableProfile {
    if (!obj || typeof obj !== 'object') throw new Error('Not a JSON object');
    const o = obj as Record<string, unknown>;

    if (o.format !== PORTABLE_PROFILE_FORMAT) {
        throw new Error(`Expected format "${PORTABLE_PROFILE_FORMAT}", got "${String(o.format)}"`);
    }
    if (typeof o.schemaVersion !== 'string') throw new Error('Missing schemaVersion');
    const major = o.schemaVersion.split('.')[0];
    if (major !== '1') throw new Error(`Unsupported schemaVersion: ${o.schemaVersion}`);

    if (!o.game || typeof o.game !== 'object') throw new Error('Missing game');
    if (!o.profile || typeof o.profile !== 'object') throw new Error('Missing profile');
    if (!Array.isArray(o.mods)) throw new Error('Missing mods array');

    const profileMeta = o.profile as Record<string, unknown>;
    if (typeof profileMeta.name !== 'string' || profileMeta.name.trim() === '') {
        throw new Error('Profile name required');
    }

    for (let i = 0; i < o.mods.length; i++) {
        const m = o.mods[i] as Record<string, unknown>;
        if (typeof m.source !== 'string') throw new Error(`mods[${i}].source missing`);
        if (!m.ref || typeof m.ref !== 'object') throw new Error(`mods[${i}].ref missing`);
        if (typeof m.enabled !== 'boolean') throw new Error(`mods[${i}].enabled missing`);
        if (typeof m.priority !== 'number') throw new Error(`mods[${i}].priority missing`);

        if (m.source === 'gamebanana') {
            const ref = m.ref as Record<string, unknown>;
            if (typeof ref.submissionId !== 'number') throw new Error(`mods[${i}].ref.submissionId missing`);
            if (typeof ref.fileId !== 'number') throw new Error(`mods[${i}].ref.fileId missing`);
        }
    }

    return obj as PortableProfile;
}

/** Accept either a raw JSON string or a share code (mp1:...). */
export function parsePortableProfile(input: string): PortableProfile {
    const trimmed = input.trim();
    const json = trimmed.startsWith(PORTABLE_PROFILE_SHARE_PREFIX)
        ? decodeShareCode(trimmed)
        : trimmed;

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (err) {
        throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return validatePortable(parsed);
}

/** Resolve each mod entry against its source. For GameBanana we pin the
 *  exact fileId, falling back to the newest non-archived file of the same
 *  submission when the pinned file is archived or missing. */
export async function resolvePortableProfile(
    profile: PortableProfile
): Promise<PortableResolutionReport> {
    const resolved: PortableResolvedMod[] = [];

    for (const entry of profile.mods) {
        resolved.push(await resolveOne(entry));
    }

    let exactCount = 0;
    let upgradedCount = 0;
    let unresolvableCount = 0;
    for (const r of resolved) {
        if (r.status === 'exact') exactCount++;
        else if (r.status === 'upgraded') upgradedCount++;
        else unresolvableCount++;
    }

    return { profile, resolved, exactCount, upgradedCount, unresolvableCount };
}

async function resolveOne(entry: PortableModEntry): Promise<PortableResolvedMod> {
    if (entry.source !== 'gamebanana') {
        return {
            entry,
            status: 'unresolvable',
            reason: `Unknown source "${entry.source}"`,
        };
    }

    const ref = entry.ref as { submissionId: number; fileId: number; section?: string };
    const section = ref.section || 'Mod';

    let details;
    try {
        details = await fetchModDetails(ref.submissionId, section);
    } catch (err) {
        return {
            entry,
            status: 'unresolvable',
            reason: `Submission ${ref.submissionId} lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const files = details.files || [];
    if (files.length === 0) {
        return {
            entry,
            status: 'unresolvable',
            reason: `Submission ${ref.submissionId} has no downloadable files`,
        };
    }

    const pinned = files.find((f) => f.id === ref.fileId);
    if (pinned && !pinned.isArchived) {
        return {
            entry,
            status: 'exact',
            resolvedFileId: pinned.id,
            resolvedFileName: pinned.fileName,
        };
    }

    const live = files.filter((f) => !f.isArchived);
    if (live.length === 0) {
        return {
            entry,
            status: 'unresolvable',
            reason: 'All files on this submission are archived',
        };
    }
    let newest = live[0];
    for (const f of live) {
        if (f.downloadCount > newest.downloadCount) newest = f;
    }
    return {
        entry,
        status: 'upgraded',
        resolvedFileId: newest.id,
        resolvedFileName: newest.fileName,
    };
}

/** Build a local Grimoire Profile from a resolved portable import after the
 *  downloads have completed. Maps each accepted entry's (submissionId,
 *  resolvedFileId) back to the installed mod fileName via the metadata
 *  sidecar. Entries with no matching install on disk are silently dropped:
 *  the caller has already shown the user which downloads succeeded. */
export async function createProfileFromPortable(
    deadlockPath: string,
    portable: PortableProfile,
    resolved: PortableResolvedMod[]
): Promise<Profile> {
    const installed = await scanMods(deadlockPath);
    const keyMap = new Map<string, string>();
    for (const mod of installed) {
        const meta = getModMetadata(mod.fileName);
        if (meta?.gameBananaId !== undefined && meta?.gameBananaFileId !== undefined) {
            keyMap.set(`${meta.gameBananaId}:${meta.gameBananaFileId}`, mod.fileName);
        }
    }

    const profileMods: ProfileMod[] = [];
    for (const r of resolved) {
        if (r.status === 'unresolvable') continue;
        if (r.entry.source !== 'gamebanana') continue;
        if (r.resolvedFileId === undefined) continue;
        const ref = r.entry.ref as { submissionId: number };
        const fileName = keyMap.get(`${ref.submissionId}:${r.resolvedFileId}`);
        if (!fileName) continue;

        profileMods.push({
            fileName,
            enabled: r.entry.enabled,
            priority: r.entry.priority,
        });
    }

    const now = new Date().toISOString();
    const profile: Profile = {
        id: generateProfileId(),
        name: portable.profile.name,
        mods: profileMods,
        crosshair: portable.extensions?.grimoire?.crosshair,
        autoexecCommands: portable.extensions?.grimoire?.autoexecCommands,
        createdAt: now,
        updatedAt: now,
    };

    return addProfile(profile);
}

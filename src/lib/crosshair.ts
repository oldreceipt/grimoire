// Shared crosshair settings model: single source for defaults, legacy-preset
// migration, console-command generation, and machine_convars.vcfg parsing.
// Imported by BOTH the renderer (store, preview) and the main process
// (crosshairPresets ipc, profiles service), so keep it dependency-free and
// DOM-free.
//
// The convar surface below was verified against the current client.dll:
// the old `citadel_crosshair_pip_border` bool no longer exists; pip and dot
// outlines are now (border width, gap, opacity) triples sharing an outline
// color, and the dot gained an explicit size.

import type { CrosshairSettings } from '../types/electron';

export const CROSSHAIR_DEFAULTS: CrosshairSettings = {
    pipGap: 5,
    pipGapStatic: true,
    pipHeight: 10,
    pipWidth: 2,
    pipOpacity: 1,
    pipOutlineBorder: 1,
    pipOutlineGap: 0,
    pipOutlineOpacity: 1,
    dotOpacity: 0,
    dotSize: 8,
    dotOutlineBorder: 2,
    dotOutlineGap: 0,
    dotOutlineOpacity: 0,
    colorR: 0,
    colorG: 255,
    colorB: 0,
    outlineColorR: 0,
    outlineColorG: 0,
    outlineColorB: 0,
    disableHeroSpecificCrosshairs: false,
    pipBorder: true,
};

const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;

/**
 * Fill defaults and migrate legacy shapes (pre outline system, where the only
 * border control was the `pipBorder` bool). Always returns a complete,
 * self-consistent settings object whose `pipBorder` is re-derived so older
 * Grimoire builds importing a shared profile/preset still see a sane value.
 */
export function normalizeCrosshairSettings(
    raw: Partial<CrosshairSettings> | undefined | null
): CrosshairSettings {
    const r = raw ?? {};
    const d = CROSSHAIR_DEFAULTS;

    // Legacy presets carry pipBorder but none of the outline fields: map the
    // bool onto the new outline-border width before defaulting the rest.
    const legacyBorder =
        typeof r.pipBorder === 'boolean' && r.pipOutlineBorder === undefined
            ? (r.pipBorder ? 1 : 0)
            : undefined;

    const s: CrosshairSettings = {
        pipGap: num(r.pipGap, d.pipGap),
        pipGapStatic: bool(r.pipGapStatic, d.pipGapStatic),
        pipHeight: num(r.pipHeight, d.pipHeight),
        pipWidth: num(r.pipWidth, d.pipWidth),
        pipOpacity: num(r.pipOpacity, d.pipOpacity),
        pipOutlineBorder: legacyBorder ?? num(r.pipOutlineBorder, d.pipOutlineBorder),
        pipOutlineGap: num(r.pipOutlineGap, d.pipOutlineGap),
        pipOutlineOpacity: num(r.pipOutlineOpacity, d.pipOutlineOpacity),
        dotOpacity: num(r.dotOpacity, d.dotOpacity),
        dotSize: num(r.dotSize, d.dotSize),
        dotOutlineBorder: num(r.dotOutlineBorder, d.dotOutlineBorder),
        dotOutlineGap: num(r.dotOutlineGap, d.dotOutlineGap),
        dotOutlineOpacity: num(r.dotOutlineOpacity, d.dotOutlineOpacity),
        colorR: num(r.colorR, d.colorR),
        colorG: num(r.colorG, d.colorG),
        colorB: num(r.colorB, d.colorB),
        outlineColorR: num(r.outlineColorR, d.outlineColorR),
        outlineColorG: num(r.outlineColorG, d.outlineColorG),
        outlineColorB: num(r.outlineColorB, d.outlineColorB),
        disableHeroSpecificCrosshairs: bool(
            r.disableHeroSpecificCrosshairs,
            d.disableHeroSpecificCrosshairs
        ),
        pipBorder: false,
    };
    s.pipBorder = s.pipOutlineBorder > 0 && s.pipOutlineOpacity > 0;
    return s;
}

/**
 * Emit the FULL convar set the game reads for crosshair shape, so applying a
 * preset fully overrides whatever was last set in the in-game editor (partial
 * writes were why presets never looked the same in game).
 */
export function generateCrosshairCommands(raw: Partial<CrosshairSettings>): string {
    const s = normalizeCrosshairSettings(raw);
    return [
        `citadel_crosshair_pip_gap ${s.pipGap}`,
        `citadel_crosshair_pip_gap_static ${s.pipGapStatic}`,
        `citadel_crosshair_pip_height ${s.pipHeight}`,
        `citadel_crosshair_pip_width ${s.pipWidth}`,
        `citadel_crosshair_pip_opacity ${s.pipOpacity.toFixed(2)}`,
        `citadel_crosshair_pip_outline_border ${s.pipOutlineBorder}`,
        `citadel_crosshair_pip_outline_gap ${s.pipOutlineGap}`,
        `citadel_crosshair_pip_outline_opacity ${s.pipOutlineOpacity.toFixed(2)}`,
        `citadel_crosshair_dot_size ${s.dotSize}`,
        `citadel_crosshair_dot_opacity ${s.dotOpacity.toFixed(2)}`,
        `citadel_crosshair_dot_outline_border ${s.dotOutlineBorder}`,
        `citadel_crosshair_dot_outline_gap ${s.dotOutlineGap}`,
        `citadel_crosshair_dot_outline_opacity ${s.dotOutlineOpacity.toFixed(2)}`,
        `citadel_crosshair_color_r ${s.colorR}`,
        `citadel_crosshair_color_g ${s.colorG}`,
        `citadel_crosshair_color_b ${s.colorB}`,
        `citadel_crosshair_outline_color_r ${s.outlineColorR}`,
        `citadel_crosshair_outline_color_g ${s.outlineColorG}`,
        `citadel_crosshair_outline_color_b ${s.outlineColorB}`,
        `citadel_crosshair_disable_hero_specific_crosshairs ${s.disableHeroSpecificCrosshairs}`,
    ].join('\n');
}

/** Convar -> settings field, used to import the player's live in-game
 *  crosshair from game/citadel/cfg/machine_convars.vcfg. */
const CONVAR_FIELDS: Array<[string, keyof CrosshairSettings, 'number' | 'boolean']> = [
    ['citadel_crosshair_pip_gap', 'pipGap', 'number'],
    ['citadel_crosshair_pip_gap_static', 'pipGapStatic', 'boolean'],
    ['citadel_crosshair_pip_height', 'pipHeight', 'number'],
    ['citadel_crosshair_pip_width', 'pipWidth', 'number'],
    ['citadel_crosshair_pip_opacity', 'pipOpacity', 'number'],
    ['citadel_crosshair_pip_outline_border', 'pipOutlineBorder', 'number'],
    ['citadel_crosshair_pip_outline_gap', 'pipOutlineGap', 'number'],
    ['citadel_crosshair_pip_outline_opacity', 'pipOutlineOpacity', 'number'],
    ['citadel_crosshair_dot_size', 'dotSize', 'number'],
    ['citadel_crosshair_dot_opacity', 'dotOpacity', 'number'],
    ['citadel_crosshair_dot_outline_border', 'dotOutlineBorder', 'number'],
    ['citadel_crosshair_dot_outline_gap', 'dotOutlineGap', 'number'],
    ['citadel_crosshair_dot_outline_opacity', 'dotOutlineOpacity', 'number'],
    ['citadel_crosshair_color_r', 'colorR', 'number'],
    ['citadel_crosshair_color_g', 'colorG', 'number'],
    ['citadel_crosshair_color_b', 'colorB', 'number'],
    ['citadel_crosshair_outline_color_r', 'outlineColorR', 'number'],
    ['citadel_crosshair_outline_color_g', 'outlineColorG', 'number'],
    ['citadel_crosshair_outline_color_b', 'outlineColorB', 'number'],
    ['citadel_crosshair_disable_hero_specific_crosshairs', 'disableHeroSpecificCrosshairs', 'boolean'],
];

/**
 * Extract crosshair convars from machine_convars.vcfg content (the KV file
 * where the game persists in-game settings). Returns only the fields actually
 * present so callers can tell "file had no crosshair data" from defaults.
 */
export function parseMachineConvarsCrosshair(content: string): Partial<CrosshairSettings> {
    const values = new Map<string, string>();
    for (const m of content.matchAll(/"(citadel_crosshair_[a-z_]+)"\s*"([^"]*)"/g)) {
        values.set(m[1], m[2]);
    }

    const out: Partial<CrosshairSettings> = {};
    const target = out as Record<string, number | boolean>;
    for (const [convar, field, kind] of CONVAR_FIELDS) {
        const v = values.get(convar);
        if (v === undefined) continue;
        if (kind === 'boolean') {
            target[field] = v === 'true' || v === '1';
        } else {
            const n = parseFloat(v);
            // The in-game sliders persist raw floats (e.g. dot_size 8.301266);
            // 2 decimals is visually identical and keeps the editor clean.
            if (Number.isFinite(n)) target[field] = Math.round(n * 100) / 100;
        }
    }
    return out;
}

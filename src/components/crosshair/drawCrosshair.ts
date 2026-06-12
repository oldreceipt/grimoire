// Single canvas renderer for the crosshair: the live preview, the preset
// gallery tiles, and saved thumbnails all draw through here, so they can
// never drift apart (the old DOM preview and SVG thumbnail disagreed on dot
// size and outline z-order).
//
// Geometry is computed in 1080p-reference pixels (the same unit the
// citadel_crosshair_* convars use) and multiplied by `scale`
// (display resolution height / 1080, times any preview zoom).

import type { CrosshairSettings } from '../../types/electron';
import { normalizeCrosshairSettings } from '../../lib/crosshair';

export interface DrawCrosshairOptions {
    /** Canvas logical (CSS) size in px; the crosshair is centered in it. */
    size: number;
    /** 1080p-px to display-px multiplier. */
    scale: number;
    /** Background fill; null/undefined leaves the canvas transparent. */
    background?: string | null;
}

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export function drawCrosshair(
    ctx: CanvasRenderingContext2D,
    raw: Partial<CrosshairSettings>,
    opts: DrawCrosshairOptions
): void {
    const s = normalizeCrosshairSettings(raw);
    const { size, scale } = opts;

    ctx.clearRect(0, 0, size, size);
    if (opts.background) {
        ctx.fillStyle = opts.background;
        ctx.fillRect(0, 0, size, size);
    }

    const cx = size / 2;
    const cy = size / 2;
    const px = (v: number) => v * scale;

    // Gap formula carried over from the previous DOM preview (calibrated
    // against the game; re-verify after any in-game crosshair update).
    // D = distance from screen center to each pip's center line.
    const D = Math.max(0, (9 + s.pipGap * 2.5) / 2);

    // Pip rects in 1080p units, relative to center; pips are centered on the
    // gap boundary (half extends inward, half outward), matching the game.
    const pips: Rect[] =
        s.pipWidth > 0 && s.pipHeight > 0
            ? [
                  { x: -s.pipWidth / 2, y: -D - s.pipHeight / 2, w: s.pipWidth, h: s.pipHeight }, // top
                  { x: -s.pipWidth / 2, y: D - s.pipHeight / 2, w: s.pipWidth, h: s.pipHeight }, // bottom
                  { x: -D - s.pipHeight / 2, y: -s.pipWidth / 2, w: s.pipHeight, h: s.pipWidth }, // left
                  { x: D - s.pipHeight / 2, y: -s.pipWidth / 2, w: s.pipHeight, h: s.pipWidth }, // right
              ]
            : [];

    const fillColor = `rgba(${s.colorR}, ${s.colorG}, ${s.colorB}, ${s.pipOpacity})`;
    const dotColor = `rgba(${s.colorR}, ${s.colorG}, ${s.colorB}, ${s.dotOpacity})`;
    const outlineColor = (opacity: number) =>
        `rgba(${s.outlineColorR}, ${s.outlineColorG}, ${s.outlineColorB}, ${opacity})`;

    // 1. Pip outlines (stroked fully outside the pip, offset by the gap)
    if (s.pipOutlineBorder > 0 && s.pipOutlineOpacity > 0) {
        ctx.strokeStyle = outlineColor(s.pipOutlineOpacity);
        ctx.lineWidth = px(s.pipOutlineBorder);
        const off = s.pipOutlineGap + s.pipOutlineBorder / 2;
        for (const r of pips) {
            ctx.strokeRect(
                cx + px(r.x - off),
                cy + px(r.y - off),
                px(r.w + 2 * off),
                px(r.h + 2 * off)
            );
        }
    }

    // 2. Dot outline ring (outside the dot, offset by the gap)
    if (s.dotOutlineBorder > 0 && s.dotOutlineOpacity > 0) {
        ctx.strokeStyle = outlineColor(s.dotOutlineOpacity);
        ctx.lineWidth = px(s.dotOutlineBorder);
        ctx.beginPath();
        ctx.arc(cx, cy, px(s.dotSize / 2 + s.dotOutlineGap + s.dotOutlineBorder / 2), 0, Math.PI * 2);
        ctx.stroke();
    }

    // 3. Pips
    if (s.pipOpacity > 0) {
        ctx.fillStyle = fillColor;
        for (const r of pips) {
            ctx.fillRect(cx + px(r.x), cy + px(r.y), px(r.w), px(r.h));
        }
    }

    // 4. Center dot (top layer)
    if (s.dotOpacity > 0 && s.dotSize > 0) {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(cx, cy, px(s.dotSize / 2), 0, Math.PI * 2);
        ctx.fill();
    }
}

/** Render a preset thumbnail PNG (data URL) with the same renderer the live
 *  preview uses. 1.333 scale = 1440p, the gallery's reference look. */
export function renderCrosshairThumbnail(
    settings: Partial<CrosshairSettings>,
    size = 100,
    scale = 1440 / 1080
): string {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    drawCrosshair(ctx, settings, { size, scale, background: '#555' });
    return canvas.toDataURL('image/png');
}

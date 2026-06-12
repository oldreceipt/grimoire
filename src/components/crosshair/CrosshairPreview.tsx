import { useEffect, useRef } from 'react';
import type { CrosshairSettings } from '../../types/electron';
import { useCrosshairStore } from '../../stores/crosshairStore';
import { drawCrosshair } from './drawCrosshair';

interface CrosshairPreviewProps {
    size?: number;
    scale?: number;
    // Optional override settings (for displaying saved presets/profiles;
    // legacy shapes are normalized inside the renderer)
    settings?: Partial<CrosshairSettings>;
    // Render with transparent background instead of gray
    transparent?: boolean;
}

export default function CrosshairPreview({ size = 200, scale = 1, settings, transparent }: CrosshairPreviewProps) {
    const storeSettings = useCrosshairStore();
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Use provided settings or fall back to the live editor state
    const s = settings || storeSettings;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Backing store at device resolution so the crosshair stays crisp
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        drawCrosshair(ctx, s, { size, scale, background: transparent ? null : '#555' });
    }, [s, size, scale, transparent]);

    return (
        <canvas
            ref={canvasRef}
            className="rounded-lg"
            style={{ width: size, height: size }}
        />
    );
}

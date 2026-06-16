import * as THREE from 'three';

/**
 * Curated dark backdrops baked behind the model in the soul-container import
 * preview + saved thumbnail, so cards have depth instead of floating on
 * transparency. Each entry paints a 2D gradient that becomes a CanvasTexture
 * for `scene.background`. The modal picks one at random per import (and can
 * reroll); a negative index means no backdrop.
 */
type BackdropDraw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const radialFill = (cx: number, cy: number, inner: string, outer: string): BackdropDraw =>
  (ctx, w, h) => {
    const g = ctx.createRadialGradient(w * cx, h * cy, 0, w * cx, h * cy, Math.hypot(w, h) * 0.72);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };

const linearFill = (top: string, bottom: string): BackdropDraw => (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
};

const SOUL_BACKDROPS: BackdropDraw[] = [
  radialFill(0.5, 0.42, '#272727', '#0b0b0b'), // charcoal spotlight
  radialFill(0.5, 0.82, '#3a2410', '#090909'), // warm ember glow from below
  linearFill('#1a2533', '#07090d'), // cool abyss blue
  radialFill(0.5, 0.4, '#241836', '#0a0710'), // violet soul
  radialFill(0.5, 0.46, '#10221a', '#070b08'), // deep forest
  radialFill(0.5, 0.46, '#2a1115', '#0c0708'), // crimson dusk
];

export const SOUL_BACKDROP_COUNT = SOUL_BACKDROPS.length;

/** Build a CanvasTexture for the backdrop at `index`, or null if out of range. */
export function makeBackdropTexture(index: number): THREE.CanvasTexture | null {
  const draw = SOUL_BACKDROPS[index];
  if (!draw) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

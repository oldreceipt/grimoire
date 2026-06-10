/** Human-readable byte size (B/KB/MB/GB). Values >= 10 (and plain bytes) round
 *  to integers; smaller values keep one decimal with a trailing .0 trimmed.
 *  Zero, negative, or non-finite input returns `zeroLabel` so callers showing
 *  unknown sizes can pass '' to render nothing. */
export function formatBytes(bytes: number, zeroLabel = '0 B'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return zeroLabel;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  const value = i === 0 || n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
  return `${value} ${units[i]}`;
}

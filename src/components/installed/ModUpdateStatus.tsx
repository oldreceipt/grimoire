import { AlertTriangle, Check, Download, Loader2, RotateCcw, X } from 'lucide-react';
import type { ModUpdateProgress } from '../../types/modUpdate';

interface Props {
  progress: ModUpdateProgress;
  onCancel?: () => void;
  onRetry?: () => void;
}

const PHASE_LABELS = {
  preparing: 'Preparing',
  downloading: 'Downloading',
  installing: 'Installing',
  updated: 'Updated',
  failed: 'Update failed',
  cancelled: 'Cancelled',
  'needs-choice': 'Needs user choice',
} as const;

export default function ModUpdateStatus({ progress, onCancel, onRetry }: Props) {
  const determinate = progress.phase === 'downloading' &&
    typeof progress.downloaded === 'number' &&
    typeof progress.total === 'number' && progress.total > 0;
  const percent = determinate
    ? Math.max(0, Math.min(100, (progress.downloaded! / progress.total!) * 100))
    : null;
  const active = ['preparing', 'downloading', 'installing'].includes(progress.phase);
  const retryable = progress.phase === 'failed' || progress.phase === 'cancelled';
  const cancellable = progress.phase === 'preparing' || progress.phase === 'downloading';
  const label = PHASE_LABELS[progress.phase];
  const Icon = progress.phase === 'updated'
    ? Check
    : progress.phase === 'failed' || progress.phase === 'needs-choice'
      ? AlertTriangle
      : progress.phase === 'cancelled'
        ? X
        : progress.phase === 'downloading'
          ? Download
          : Loader2;

  return (
    <div className="absolute inset-0 z-20 flex items-end rounded-[inherit] bg-gradient-to-t from-bg-primary/95 via-bg-primary/55 to-transparent pointer-events-none">
      <div className="w-full border-t border-white/10 bg-bg-secondary/95 p-3 shadow-xl backdrop-blur-sm">
        {/* This node changes only with the semantic phase, never byte ticks. */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {label}{progress.message ? `. ${progress.message}` : ''}
        </span>
        <div className="flex items-center gap-2">
          <Icon
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 ${active ? 'text-accent motion-safe:animate-spin' : progress.phase === 'updated' ? 'text-state-success' : 'text-state-danger'} motion-reduce:animate-none`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-sm font-semibold text-text-primary">
              <span>{label}</span>
              {percent !== null && <span className="tabular-nums">{Math.round(percent)}%</span>}
            </div>
            {progress.message && !active && (
              <p className="mt-0.5 truncate text-xs text-text-secondary" title={progress.message}>
                {progress.message}
              </p>
            )}
          </div>
          {cancellable && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="pointer-events-auto rounded-md border border-white/10 px-2 py-1 text-xs text-text-primary hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Cancel
            </button>
          )}
          {retryable && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-text-primary hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" />
              Retry
            </button>
          )}
        </div>
        {active && (
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label={`${label} ${progress.displayName}`}
            aria-valuemin={percent === null ? undefined : 0}
            aria-valuemax={percent === null ? undefined : 100}
            aria-valuenow={percent === null ? undefined : Math.round(percent)}
            aria-valuetext={percent === null ? label : `${Math.round(percent)} percent`}
          >
            <div
              className={`h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none ${percent === null ? 'w-1/3 motion-safe:animate-pulse' : ''}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

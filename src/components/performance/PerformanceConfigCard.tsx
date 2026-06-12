import { useCallback, useEffect, useState } from 'react';
import { Gauge, ExternalLink, RefreshCw } from 'lucide-react';
import { Card, Badge, Button } from '../common/ui';
import {
  applyPerformanceConfig,
  getPerformanceConfigStatus,
  removePerformanceConfig,
} from '../../lib/api';
import type { PerformanceConfigStatus } from '../../types/electron';

const OPTIMIZATIONLOCK_URL = 'https://github.com/Sqooky/OptimizationLock';
const SQOOKY_KOFI_URL = 'https://ko-fi.com/sqooky';

// Settings card for the OptimizationLock performance preset (experimental).
// Applies Sqooky's community fps config onto gameinfo.gi in place, shows
// whether a game update wiped it, and credits the upstream project.
export default function PerformanceConfigCard() {
  const [status, setStatus] = useState<PerformanceConfigStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getPerformanceConfigStatus());
    } catch {
      setStatus({
        state: 'error',
        appliedVersion: null,
        bundledVersion: '',
        message: 'Could not read gameinfo.gi status. Check your Deadlock path in Settings.',
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<PerformanceConfigStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch {
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const applied = status?.state === 'applied';
  const wiped = status?.state === 'wiped';

  return (
    <Card
      title="Performance Config"
      icon={Gauge}
      className="lg:col-span-2"
      description="Sqooky's community fps preset (OptimizationLock), applied without touching your mods."
      action={
        status && (
          <Badge variant={applied ? 'success' : wiped ? 'warning' : status.state === 'error' ? 'error' : 'neutral'}>
            {applied ? `Applied v${status.appliedVersion}` : wiped ? 'Wiped by game update' : status.state === 'error' ? 'Error' : 'Not applied'}
          </Badge>
        )
      }
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-text-secondary">{status?.message ?? 'Checking gameinfo.gi...'}</p>
          <p className="text-xs text-text-secondary">
            Map looks dark? Set in-game shadows to Medium or Low. Game updates wipe the config; Grimoire
            spots that here so you can reapply. By{' '}
            <a
              href={OPTIMIZATIONLOCK_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline inline-flex items-center gap-0.5"
            >
              Sqooky and contributors
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
            . If it helps,{' '}
            <a
              href={SQOOKY_KOFI_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              buy them a coffee
            </a>
            .
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={() => run(applyPerformanceConfig)}
            isLoading={busy}
            icon={wiped ? RefreshCw : undefined}
            size="sm"
          >
            {applied ? 'Reapply' : wiped ? 'Reapply Config' : 'Apply Config'}
          </Button>
          {(applied || wiped) && (
            <Button onClick={() => run(removePerformanceConfig)} disabled={busy} variant="secondary" size="sm">
              Remove
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

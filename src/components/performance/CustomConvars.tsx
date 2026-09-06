import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Toggle } from '../common/ui';
import type { CustomConvarSettings, CustomConvarStatus } from '../../types/electron';

export default function CustomConvars({ revision, onApplied }: { revision: unknown; onApplied: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CustomConvarStatus | null>(null);
  const [draft, setDraft] = useState<CustomConvarSettings>({ entries: [], autoRestore: false });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI.getCustomConvarStatus();
      setStatus(next);
      if (!dirty) setDraft(next.settings);
      setLoadError(null);
    } catch (err) { setLoadError(String(err)); }
  }, [dirty]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  useEffect(() => {
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);

  const change = (next: CustomConvarSettings) => { setDraft(next); setDirty(true); setNotice(null); };
  const save = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await window.electronAPI.saveCustomConvars(draft);
      setStatus(saved);
      setDraft(saved.settings);
      setDirty(false);
      if (apply) {
        setNotice(t('performance.custom.savedBeforeApply'));
        const applied = await window.electronAPI.applyCustomConvars();
        setStatus(applied);
        setError(applied.error);
        setNotice(t('performance.custom.applied'));
        onApplied();
      } else setNotice(t('performance.custom.saved'));
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const displayedError = error ?? loadError ?? status?.error;
  const inputClass = 'w-full min-w-0 rounded-sm border border-white/10 bg-bg-primary px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent';
  return (
    <section className="p-5 space-y-4" aria-labelledby="custom-convars-title">
      <h3 id="custom-convars-title" className="font-medium text-text-primary">{t('performance.custom.title')}</h3>
      {draft.entries.map((entry, index) => (
        <div key={index} className="flex items-end gap-2">
          <label className="flex items-center py-2.5">
            <input type="checkbox" className="accent-accent" checked={entry.enabled !== false} disabled={busy}
              aria-label={t('performance.custom.enable', { name: entry.key || index + 1 })}
              onChange={(event) => change({ ...draft, entries: draft.entries.map((row, i) => i === index ? { ...row, enabled: event.target.checked } : row) })} />
          </label>
          <label className="min-w-0 flex-1 space-y-1">
            <span className={index === 0 ? 'text-xs text-text-secondary' : 'sr-only'}>{t('performance.custom.name')}</span>
            <input className={inputClass} value={entry.key} placeholder="r_aspectratio" disabled={busy}
              onChange={(event) => change({ ...draft, entries: draft.entries.map((row, i) => i === index ? { ...row, key: event.target.value } : row) })} />
          </label>
          <label className="min-w-0 flex-1 space-y-1">
            <span className={index === 0 ? 'text-xs text-text-secondary' : 'sr-only'}>{t('performance.custom.value')}</span>
            <input className={inputClass} value={entry.value} placeholder="2.15" disabled={busy}
              onChange={(event) => change({ ...draft, entries: draft.entries.map((row, i) => i === index ? { ...row, value: event.target.value } : row) })} />
          </label>
          <button type="button" className="p-2.5 text-text-secondary hover:text-state-danger" disabled={busy}
            aria-label={t('performance.custom.remove', { name: entry.key || index + 1 })}
            onClick={() => change({ ...draft, entries: draft.entries.filter((_, i) => i !== index) })}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <Button variant="secondary" size="sm" icon={Plus} disabled={busy || draft.entries.length >= 100}
        onClick={() => change({ ...draft, entries: [...draft.entries, { key: '', value: '' }] })}>
        {t('performance.custom.add')}
      </Button>
      <Toggle checked={draft.autoRestore} disabled={busy}
        onChange={(autoRestore) => change({ ...draft, autoRestore })}
        label={t('performance.custom.autoRestore')} />
      {dirty && <p className="text-xs text-state-info">{t('performance.custom.unsaved')}</p>}
      {!dirty && status && !status.applied && !displayedError && <p className="text-xs text-state-warning">{t('performance.custom.pending')}</p>}
      {notice && <p className="text-xs text-text-secondary" role="status">{notice}</p>}
      {displayedError && <p className="text-xs text-state-danger" role="alert">{displayedError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save(true)}>{t('performance.custom.saveApply')}</Button>
        <Button variant="secondary" size="sm" disabled={busy || !dirty} onClick={() => void save(false)}>{t('performance.custom.save')}</Button>
      </div>
    </section>
  );
}

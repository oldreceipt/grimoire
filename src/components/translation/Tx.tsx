import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useTranslationStore } from '../../stores/translationStore';

interface TxProps {
  k: string;
  values?: Record<string, unknown>;
  fallback?: string;
  className?: string;
}

const PLACEHOLDER_RE = /{{\s*([\w.-]+)\s*}}/g;

export default function Tx({ k, values, fallback, className = '' }: TxProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const enabled = useTranslationStore((s) => s.enabled);
  const signedIn = useTranslationStore((s) => s.signedIn);
  const languageCode = useTranslationStore((s) => s.languageCode);
  const row = useTranslationStore((s) => s.rowsByKey[k]);
  const override = useTranslationStore((s) => s.localOverrides[k]);
  const saving = useTranslationStore((s) => !!s.savingKeys[k]);
  const saved = useTranslationStore((s) => !!s.savedKeys[k]);
  const remoteError = useTranslationStore((s) => s.errors[k]);
  const saveSuggestion = useTranslationStore((s) => s.saveSuggestion);

  const active = enabled && signedIn && !!languageCode;
  const source = useMemo(() => {
    const en = i18n.getFixedT('en');
    return String(en(k, values));
  }, [i18n, k, values]);
  const defaultText = fallback ?? String(t(k, values));
  const candidate = override ?? row?.value ?? '';
  const displayText = active && candidate.trim() ? formatTemplate(candidate, values) : defaultText;

  const openEditor = () => {
    if (!active) return;
    setDraft(override ?? row?.value ?? '');
    setLocalError(null);
    setEditing(true);
  };

  const save = async () => {
    const check = checkPlaceholders(source, draft);
    if (check.missing.length || check.extra.length) {
      setLocalError(
        `Keep the {{tags}}: missing ${check.missing.join(', ') || 'none'}, extra ${
          check.extra.join(', ') || 'none'
        }`
      );
      return;
    }
    const ok = await saveSuggestion({
      key: k,
      source,
      value: draft,
      contextRoute: location.pathname,
    });
    if (ok) setEditing(false);
  };

  return (
    <>
      <span
        className={`${className} ${
          active
            ? 'rounded-[3px] outline outline-1 outline-teal-300/40 bg-teal-300/10 hover:bg-teal-300/20 cursor-text'
            : ''
        }`}
        title={active ? `Double-click to translate ${k}` : undefined}
        data-i18n-key={active ? k : undefined}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openEditor();
        }}
      >
        {displayText}
      </span>
      {editing &&
        createPortal(
          <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 px-4">
            <div className="w-full max-w-lg rounded-lg border border-border bg-bg-secondary p-4 shadow-2xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-text-tertiary">{k}</div>
                  <div className="mt-1 text-sm font-medium text-text-primary">{source}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-sm p-1 text-text-secondary hover:bg-white/10 hover:text-text-primary"
                  aria-label="Close translation editor"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setLocalError(null);
                }}
                autoFocus
                rows={4}
                className="w-full resize-y rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
                dir="auto"
              />
              {(localError || remoteError) && (
                <div className="mt-2 flex items-start gap-2 text-xs text-state-danger">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>{localError || remoteError}</span>
                </div>
              )}
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="text-xs text-text-secondary">
                  {saved ? 'Saved' : languageCode ? `Submitting to ${languageCode}` : ''}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-2 text-sm font-medium text-bg-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

function formatTemplate(template: string, values?: Record<string, unknown>): string {
  if (!values) return template;
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = values[name];
    return value === undefined || value === null ? match : String(value);
  });
}

function placeholders(value: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(value))) found.add(match[1]);
  return [...found].sort();
}

function checkPlaceholders(source: string, target: string): { missing: string[]; extra: string[] } {
  const sourceVars = new Set(placeholders(source));
  const targetVars = new Set(placeholders(target));
  return {
    missing: [...sourceVars].filter((name) => !targetVars.has(name)).sort(),
    extra: [...targetVars].filter((name) => !sourceVars.has(name)).sort(),
  };
}

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  Loader2,
  AlertTriangle,
  Trash2,
  ExternalLink,
  Heart,
  Boxes,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button, Badge } from '../common/ui';
import {
  socialMe,
  socialDeleteProfile,
  type SocialMeResponse,
} from '../../lib/api';
import { formatRelativeDate } from '../../lib/dates';

interface MyPublishedSectionProps {
  // Bumped by the parent whenever a publish completes elsewhere so this
  // section refetches without remounting.
  refreshKey?: number;
  onOpenProfile?: (profileId: string) => void;
  // Notify parent when a profile was unpublished so the main Discover list
  // can drop the row optimistically.
  onUnpublished?: (profileId: string) => void;
}

function isoFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

export default function MyPublishedSection({
  refreshKey,
  onOpenProfile,
  onUnpublished,
}: MyPublishedSectionProps) {
  const [data, setData] = useState<SocialMeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await socialMe();
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const handleUnpublish = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await socialDeleteProfile(id);
        setData((prev) =>
          prev ? { ...prev, profiles: prev.profiles.filter((p) => p.id !== id) } : prev
        );
        onUnpublished?.(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingId(null);
        setConfirmingId(null);
      }
    },
    [onUnpublished]
  );

  const count = data?.profiles.length ?? 0;

  return (
    <div className="bg-bg-secondary border border-white/10 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors cursor-pointer text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Upload className="w-4 h-4 text-accent flex-shrink-0" />
          <span className="text-sm font-medium text-text-primary">Your uploads</span>
          <Badge variant="neutral">
            {loading && !data ? '...' : `${count} published`}
          </Badge>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-white/5">
          {loading && !data && (
            <div className="px-4 py-3 text-sm text-text-secondary inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading your profiles...
            </div>
          )}

          {error && (
            <div className="px-4 py-3 text-xs text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="ml-auto underline text-red-300 hover:text-red-200"
              >
                Retry
              </button>
            </div>
          )}

          {data && data.profiles.length === 0 && (
            <div className="px-4 py-4 text-xs text-text-secondary">
              You haven't published anything yet. Open Profiles, pick one, and click Publish to Discover.
            </div>
          )}

          {data && data.profiles.length > 0 && (
            <ul className="divide-y divide-white/5">
              {data.profiles.map((p) => {
                const confirming = confirmingId === p.id;
                const busy = deletingId === p.id;
                return (
                  <li
                    key={p.id}
                    className="px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text-primary font-medium truncate" title={p.title}>
                        {p.title}
                      </div>
                      <div className="text-xs text-text-secondary flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap">
                        <span className="inline-flex items-center gap-1">
                          <Boxes className="w-3 h-3" />
                          {p.mod_count} {p.mod_count === 1 ? 'mod' : 'mods'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Heart className="w-3 h-3" />
                          {p.like_count}
                        </span>
                        {p.primary_hero && (
                          <span className="text-text-tertiary">· {p.primary_hero}</span>
                        )}
                        {p.is_featured && (
                          <span className="inline-flex items-center gap-1 text-green-300">
                            <Sparkles className="w-3 h-3" />
                            Featured
                          </span>
                        )}
                        <span className="text-text-tertiary">
                          · {formatRelativeDate(isoFromUnix(p.created_at))}
                        </span>
                      </div>
                    </div>

                    {confirming ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-secondary">Unpublish?</span>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void handleUnpublish(p.id)}
                          isLoading={busy}
                          disabled={busy}
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmingId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        {onOpenProfile && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={ExternalLink}
                            onClick={() => onOpenProfile(p.id)}
                            title="View details"
                          >
                            View
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          onClick={() => setConfirmingId(p.id)}
                          title="Unpublish this profile"
                        >
                          Unpublish
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import {
  Globe2,
  Heart,
  AlertTriangle,
  Sparkles,
  Clock,
  Flame,
  CloudOff,
  X,
  ExternalLink,
  ShieldCheck,
  Boxes,
  User as UserIcon,
} from 'lucide-react';
import { SteamIcon } from '../components/social/SteamIcon';
import {
  socialListProfiles,
  socialLike,
  socialUnlike,
  type SocialListProfilesResponse,
  type SocialProfileSort,
} from '../lib/api';
import { useAppStore } from '../stores/appStore';
import { useSocialStore } from '../stores/socialStore';
import { Card, Badge, Button } from '../components/common/ui';
import { EmptyState, PageHeader } from '../components/common/PageComponents';
import ImportProfileDialog from '../components/profiles/ImportProfileDialog';
import MyPublishedSection from '../components/social/MyPublishedSection';
import { getActiveDeadlockPath } from '../lib/appSettings';
import { formatRelativeDate } from '../lib/dates';

type SortKey = Extract<SocialProfileSort, 'top' | 'new' | 'featured'>;

const SORTS: { key: SortKey; label: string; icon: typeof Flame }[] = [
  { key: 'top', label: 'Top', icon: Flame },
  { key: 'new', label: 'New', icon: Clock },
  { key: 'featured', label: 'Featured', icon: Sparkles },
];

type CardProfile = SocialListProfilesResponse['profiles'][number];

function isoFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

export default function Discover() {
  const settings = useAppStore((s) => s.settings);
  const hideNsfw = settings?.hideNsfwPreviews ?? true;
  const signedIn = useSocialStore((s) => s.status.signedIn);
  const user = useSocialStore((s) => s.status.user);
  const signInBusy = useSocialStore((s) => s.loading);
  const signInError = useSocialStore((s) => s.error);
  const login = useSocialStore((s) => s.login);
  const cancelLogin = useSocialStore((s) => s.cancelLogin);
  const clearSignInError = useSocialStore((s) => s.clearError);

  const handleSignIn = useCallback(async () => {
    try {
      await login();
    } catch {
      // store already captured the error; banner shows it
    }
  }, [login]);

  const [sort, setSort] = useState<SortKey>('top');
  const [data, setData] = useState<SocialListProfilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [likingId, setLikingId] = useState<string | null>(null);
  // Pulses the header sign-in button when a signed-out user clicks Like.
  const [signInPulse, setSignInPulse] = useState(false);

  // The active card-import target: profileId + a seed row from the list so the
  // dialog's left rail can render instantly while /v1/profiles/:id loads.
  const [importTarget, setImportTarget] = useState<CardProfile | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await socialListProfiles({ sort, hideNsfw });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sort, hideNsfw]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const applyLikeUpdate = useCallback((id: string, likeCount: number) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        profiles: prev.profiles.map((p) =>
          p.id === id ? { ...p, like_count: likeCount } : p
        ),
      };
    });
  }, []);

  const handleCardLikeClick = useCallback(
    async (e: React.MouseEvent, profile: CardProfile) => {
      e.stopPropagation();
      if (!signedIn) {
        // Don't auto-open Steam. Just nudge the header button.
        setSignInPulse(true);
        window.setTimeout(() => setSignInPulse(false), 1200);
        return;
      }
      if (likingId) return;
      setLikingId(profile.id);
      try {
        // We don't track viewer_has_liked on the list response (only on detail).
        // Best-effort: try Like first; if the server says "already liked"
        // (typically 409), fall back to Unlike for toggle UX.
        const res = await socialLike(profile.id);
        applyLikeUpdate(profile.id, res.like_count);
      } catch (err) {
        try {
          const res = await socialUnlike(profile.id);
          applyLikeUpdate(profile.id, res.like_count);
        } catch {
          console.warn('[discover] like toggle failed:', err);
        }
      } finally {
        setLikingId(null);
      }
    },
    [signedIn, likingId, applyLikeUpdate]
  );


  // Top-right header action: either a sign-in CTA (signed-out) or the user
  // chip (signed-in). The pulse class fires when a signed-out user clicks a
  // card's like button so the right action is obvious.
  const headerAction = signedIn && user ? (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-bg-secondary border border-white/10"
      title={`Signed in as ${user.display_name}`}
    >
      {user.avatar_url ? (
        <img
          src={user.avatar_url}
          alt=""
          referrerPolicy="no-referrer"
          className="w-5 h-5 rounded-full"
        />
      ) : (
        <UserIcon className="w-4 h-4 text-text-secondary" />
      )}
      <span className="text-xs text-text-primary truncate max-w-[10rem]">
        {user.display_name}
      </span>
    </div>
  ) : (
    <div
      className={`flex items-center gap-2 rounded-md transition-shadow ${signInPulse ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-primary shadow-[0_0_0_4px_rgba(56,189,248,0.25)] animate-pulse' : ''}`}
    >
      <Button
        size="sm"
        icon={SteamIcon}
        onClick={handleSignIn}
        isLoading={signInBusy}
        disabled={signInBusy}
        title="Opens Steam in your browser. Grimoire never sees your password."
      >
        Sign in with Steam
      </Button>
      {signInBusy && (
        <Button size="sm" variant="secondary" icon={X} onClick={cancelLogin}>
          Cancel
        </Button>
      )}
    </div>
  );

  return (
    <div className="p-6 space-y-6 h-full overflow-y-auto">
      <PageHeader
        title="Discover"
        description="Mod profiles published by other Grimoire users."
        stats={data ? `${data.total} ${data.total === 1 ? 'profile' : 'profiles'}` : undefined}
        action={headerAction}
      />

      {!signedIn && signInBusy && (
        <div className="text-xs text-text-secondary flex items-start gap-1.5">
          <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            Finish signing in with Steam in your browser. The header will update when you're done.
          </span>
        </div>
      )}
      {!signedIn && signInError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-md p-2.5 text-xs text-red-400 flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span className="break-words">{signInError}</span>
          </div>
          <button
            onClick={clearSignInError}
            className="text-red-300 hover:text-red-200 underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
      {!signedIn && (
        <div className="text-[11px] text-text-tertiary flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" />
          Sign in to like and publish. Importing works without an account.
        </div>
      )}

      {signedIn && (
        <MyPublishedSection
          onOpenProfile={(id) => {
            // Prefer the discover-list seed if it's there; fall back to a
            // minimal stand-in built from the /v1/me row data via the section.
            // The dialog will refetch detail either way so the header fills in.
            const seed = data?.profiles.find((p) => p.id === id) ?? null;
            if (seed) setImportTarget(seed);
          }}
          onUnpublished={(id) => {
            setData((prev) =>
              prev ? { ...prev, profiles: prev.profiles.filter((p) => p.id !== id) } : prev
            );
          }}
        />
      )}

      <div className="flex items-center gap-1 border-b border-border">
        {SORTS.map(({ key, label, icon: Icon }) => {
          const active = sort === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={`px-4 py-2 -mb-px border-b-2 inline-flex items-center gap-2 text-sm transition-colors cursor-pointer ${
                active
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          );
        })}
      </div>

      {loading && !data && (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4 animate-pulse h-32">
              <div className="h-4 bg-white/5 rounded w-1/2 mb-2" />
              <div className="h-3 bg-white/5 rounded w-1/3 mb-4" />
              <div className="h-3 bg-white/5 rounded w-full mb-1" />
              <div className="h-3 bg-white/5 rounded w-3/4" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <EmptyState
          icon={CloudOff}
          variant="error"
          title="Couldn't reach Grimoire Social"
          description={
            <div className="space-y-2">
              <p>{error}</p>
              <p className="text-xs text-text-secondary">
                Check your connection, then switch sort tabs to retry.
              </p>
            </div>
          }
        />
      )}

      {!loading && !error && data && data.profiles.length === 0 && (
        <EmptyState
          icon={Globe2}
          title="No profiles here yet"
          description="Be the first to publish: open Profiles, pick one, and click Publish to Discover."
        />
      )}

      {data && data.profiles.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 items-start">
          {data.profiles.map((p) => {
            const isLiking = likingId === p.id;
            const isActive = importTarget?.id === p.id;
            const openImport = () => setImportTarget(p);
            const thumbs = p.thumbnail_urls ?? [];
            // 0 -> tiny placeholder bar. 1 -> full-bleed single hero. 2-4 ->
            // 2x2 mosaic, padding missing slots so the grid stays balanced.
            const mosaicSlots = thumbs.length >= 2
              ? [thumbs[0] ?? null, thumbs[1] ?? null, thumbs[2] ?? null, thumbs[3] ?? null]
              : null;
            const singleHero = thumbs.length === 1 ? thumbs[0]! : null;
            return (
              <div
                key={p.id}
                id={`discover-card-${p.id}`}
                role="button"
                tabIndex={0}
                onClick={openImport}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openImport();
                  }
                }}
                className="text-left rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
              >
                <Card className={`overflow-hidden flex flex-col transition-colors ${isActive ? 'border-accent/40' : 'hover:border-white/20'}`}>
                  {/* Image-led header: mosaic / hero with title + like
                      overlaid on a strong bottom gradient. Layouts:
                      - 0 thumbs   : flat header with title only
                      - 1 thumb    : full-bleed hero behind title
                      - 2-4 thumbs : 2x2 mosaic behind title */}
                  <div className="relative h-40 bg-bg-tertiary overflow-hidden">
                    {mosaicSlots && (
                      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0.5">
                        {mosaicSlots.map((url, i) =>
                          url ? (
                            <img
                              key={i}
                              src={url}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = 'none';
                              }}
                              className="w-full h-full object-cover object-top"
                            />
                          ) : (
                            <div key={i} className="bg-bg-tertiary/60" aria-hidden />
                          )
                        )}
                      </div>
                    )}
                    {!mosaicSlots && singleHero && (
                      <img
                        src={singleHero}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                        className="absolute inset-0 w-full h-full object-cover object-top"
                      />
                    )}

                    {/* Strong bottom gradient so the title stays readable
                        regardless of the underlying image. Black instead of
                        bg-secondary so it pops on darker thumbs too. */}
                    <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none" />

                    {/* Like button: top-right, floats over the image with a
                        backdrop-blur pill so it stays visible on any thumb. */}
                    <button
                      type="button"
                      onClick={(e) => handleCardLikeClick(e, p)}
                      disabled={isLiking}
                      className={`absolute top-2 right-2 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md backdrop-blur-sm bg-black/40 border border-white/10 transition-colors ${
                        signedIn
                          ? 'text-white hover:text-red-400 hover:bg-black/60 cursor-pointer'
                          : 'text-white/70 cursor-help hover:bg-black/60'
                      } disabled:opacity-50`}
                      title={signedIn ? 'Like / unlike' : 'Sign in to like'}
                      aria-label={signedIn ? 'Like profile' : 'Sign in to like'}
                    >
                      <Heart className={`w-3.5 h-3.5 ${isLiking ? 'animate-pulse' : ''}`} />
                      <span className="tabular-nums">{p.like_count}</span>
                    </button>

                    {/* Title overlaid on the gradient. Drop-shadow as belt-
                        and-braces in case a particular thumb beats the
                        gradient (e.g. all-white art). */}
                    <div
                      className="absolute left-3 right-3 bottom-2 text-lg font-semibold text-white truncate leading-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
                      title={p.title}
                    >
                      {p.title}
                    </div>
                  </div>

                  {/* Below the header: owner row + description (if any) +
                      badges. Tight stack so cards stay compact. */}
                  <div className="px-3.5 py-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {p.owner.avatar_url ? (
                        <img
                          src={p.owner.avatar_url}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="w-6 h-6 rounded-full flex-shrink-0"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-bg-tertiary flex items-center justify-center flex-shrink-0">
                          <UserIcon className="w-3 h-3 text-text-secondary" />
                        </div>
                      )}
                      <span className="text-xs text-text-secondary truncate" title={p.owner.display_name}>
                        {p.owner.display_name}
                      </span>
                      <span className="text-[11px] text-text-tertiary flex-shrink-0">
                        · {formatRelativeDate(isoFromUnix(p.created_at))}
                      </span>
                    </div>

                    {p.description && (
                      <div className="text-sm text-text-secondary line-clamp-2">
                        {p.description}
                      </div>
                    )}

                    {(() => {
                      const allHeroes = p.heroes && p.heroes.length > 0
                        ? p.heroes
                        : p.primary_hero
                          ? [p.primary_hero]
                          : [];
                      const HERO_BADGES_VISIBLE = 4;
                      const visibleHeroes = allHeroes.slice(0, HERO_BADGES_VISIBLE);
                      const overflowHeroes = allHeroes.slice(HERO_BADGES_VISIBLE);
                      return (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge variant="neutral">
                            <Boxes className="w-3 h-3 mr-1 inline" />
                            {p.mod_count} {p.mod_count === 1 ? 'mod' : 'mods'}
                          </Badge>
                          {visibleHeroes.map((hero) => (
                            <Badge key={hero} variant="neutral">{hero}</Badge>
                          ))}
                          {overflowHeroes.length > 0 && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium border bg-white/5 text-text-secondary border-white/10 opacity-70"
                              title={overflowHeroes.join(', ')}
                            >
                              +{overflowHeroes.length}
                            </span>
                          )}
                          {p.is_featured && (
                            <Badge variant="success">
                              <Sparkles className="w-3 h-3 mr-1 inline" />
                              Featured
                            </Badge>
                          )}
                          {p.has_nsfw && <Badge variant="warning">NSFW</Badge>}
                        </div>
                      );
                    })()}
                  </div>

                </Card>
              </div>
            );
          })}
        </div>
      )}

      {data && data.profiles.length > 0 && data.total > data.profiles.length && (
        <div className="text-xs text-text-secondary text-center pt-2 inline-flex items-center gap-2 justify-center w-full">
          <AlertTriangle className="w-3 h-3" />
          Pagination not wired up yet (showing first {data.page_size} of {data.total}).
        </div>
      )}

      {importTarget && (
        <ImportProfileDialog
          activeDeadlockPath={getActiveDeadlockPath(settings)}
          hideNsfwPreviews={hideNsfw}
          socialProfileId={importTarget.id}
          socialProfileSeed={importTarget}
          onClose={() => setImportTarget(null)}
          onImported={() => {
            // Stay open: the dialog shows a success state after the user
            // finishes. They can close it manually.
          }}
          onLikeChange={(id, likeCount) => applyLikeUpdate(id, likeCount)}
          onSignInRequested={() => { void handleSignIn(); }}
          onLikeWithoutSignIn={() => {
            setSignInPulse(true);
            window.setTimeout(() => setSignInPulse(false), 1200);
          }}
        />
      )}
    </div>
  );
}

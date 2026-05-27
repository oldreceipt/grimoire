import type { CSSProperties } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Download,
  Eye,
  Layers,
  Loader2,
  Play,
  ShieldCheck,
  ThumbsUp,
  Volume2,
} from 'lucide-react';
import { getHeroFacePosition, getHeroRenderPath } from '../lib/lockerUtils';

type SampleKind = 'mod' | 'sound';
type SampleAction = 'install' | 'installed' | 'queued' | 'downloading' | 'enable';
type StateBadge = 'nsfw' | 'installed' | 'outdated';

type SampleCard = {
  id: string;
  title: string;
  author: string;
  kind: SampleKind;
  hero: string;
  category: string;
  likes: string;
  views: string;
  downloads: string;
  date: string;
  action: SampleAction;
  stateBadges?: StateBadge[];
  queuePosition?: number;
  duration?: string;
};

const SAMPLE_CARDS: SampleCard[] = [
  {
    id: 'normal',
    title: "dacooderr's FPS Essentials",
    author: 'dacooderr',
    kind: 'mod',
    hero: 'Warden',
    category: 'Utility',
    likes: '3',
    views: '3.4k',
    downloads: '824',
    date: '05/27/2026',
    action: 'install',
  },
  {
    id: 'sound',
    title: 'The First Hunter - Venator Mod',
    author: 'r3djok3r1',
    kind: 'sound',
    hero: 'Venator',
    category: 'Sound',
    likes: '1',
    views: '16',
    downloads: '42',
    date: '05/27/2026',
    action: 'queued',
    queuePosition: 2,
    duration: '0:30',
  },
  {
    id: 'installed-skin',
    title: 'Kobold Paige (V2.0-NEW COLORS)',
    author: 'Squinnky',
    kind: 'mod',
    hero: 'Paige',
    category: 'Skin',
    likes: '14',
    views: '1.8k',
    downloads: '611',
    date: '03/13/2026',
    action: 'installed',
    stateBadges: ['installed'],
  },
  {
    id: 'ability-sfx',
    title: 'Seven Storm Cloud Killstreak Set',
    author: 'VoltArchive',
    kind: 'sound',
    hero: 'Seven',
    category: 'Ability SFX',
    likes: '18',
    views: '2.1k',
    downloads: '560',
    date: '05/12/2026',
    action: 'downloading',
    duration: '0:18',
  },
  {
    id: 'nsfw-hidden',
    title: 'After Hours Lash Voice Pack With Extended Author Metadata',
    author: 'RedactedUser',
    kind: 'sound',
    hero: 'Lash',
    category: 'Voice',
    likes: '7',
    views: '980',
    downloads: '130',
    date: '04/19/2026',
    action: 'enable',
    stateBadges: ['nsfw', 'installed'],
    duration: '0:24',
  },
  {
    id: 'outdated',
    title: 'Legacy Wraith Celestial HUD and Portrait Pack',
    author: 'modforge',
    kind: 'mod',
    hero: 'Wraith',
    category: 'HUD',
    likes: '29',
    views: '8.9k',
    downloads: '2.4k',
    date: '12/18/2025',
    action: 'queued',
    queuePosition: 4,
    stateBadges: ['nsfw', 'outdated'],
  },
];

const MOD_GRID_CARDS = SAMPLE_CARDS.filter((card) => card.kind === 'mod');
const SOUND_GRID_CARDS = SAMPLE_CARDS.filter((card) => card.kind === 'sound');

function hasBadge(card: SampleCard, badge: StateBadge): boolean {
  return card.stateBadges?.includes(badge) ?? false;
}

function actionLabel(card: SampleCard): string {
  switch (card.action) {
    case 'installed':
      return 'Installed';
    case 'queued':
      return card.queuePosition ? `Queued ${card.queuePosition}` : 'Queued';
    case 'downloading':
      return 'Downloading';
    case 'enable':
      return 'Enable';
    default:
      return 'Install';
  }
}

function actionTone(card: SampleCard): string {
  switch (card.action) {
    case 'installed':
      return 'border-state-success/65 bg-bg-primary text-state-success';
    case 'queued':
      return 'border-state-info/65 bg-bg-primary text-state-info';
    case 'downloading':
      return 'border-accent/65 bg-bg-primary text-accent';
    case 'enable':
      return 'border-state-warning/70 bg-bg-primary text-state-warning hover:border-state-warning';
    default:
      return 'border-accent/70 bg-bg-primary text-accent hover:border-accent';
  }
}

function badgeTone(badge: StateBadge): string {
  switch (badge) {
    case 'installed':
      return 'border-state-success/65 bg-bg-primary text-state-success';
    case 'outdated':
      return 'border-state-warning/70 bg-bg-primary text-state-warning';
    case 'nsfw':
      return 'border-state-danger/70 bg-bg-primary text-state-danger';
  }
}

function badgeLabel(badge: StateBadge): string {
  switch (badge) {
    case 'installed':
      return 'Installed';
    case 'outdated':
      return 'Outdated';
    case 'nsfw':
      return '18+';
  }
}

function heroStyle(card: SampleCard): CSSProperties {
  return { objectPosition: `${getHeroFacePosition(card.hero)}% 20%` };
}

function CategoryChip({ card }: { card: SampleCard }) {
  return (
    <span className="inline-flex h-5 max-w-[112px] items-center gap-1 rounded-sm border border-white/15 bg-bg-primary px-1.5 text-[10px] font-semibold leading-none text-text-primary shadow-[0_1px_5px_rgba(0,0,0,0.55)]">
      {card.kind === 'sound' && <Volume2 className="h-3 w-3 shrink-0 text-accent" />}
      <span className="truncate">{card.category}</span>
    </span>
  );
}

function StatusChips({ card }: { card: SampleCard }) {
  return (
    <>
      {(card.stateBadges ?? []).slice(0, 2).map((badge) => (
        <span
          key={badge}
          className={`inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] font-semibold leading-none shadow-[0_1px_5px_rgba(0,0,0,0.55)] ${badgeTone(
            badge
          )}`}
        >
          {badge === 'installed' && <Check className="h-3 w-3" />}
          {badge === 'outdated' && <AlertTriangle className="h-3 w-3" />}
          {badgeLabel(badge)}
        </span>
      ))}
    </>
  );
}

function ActionButton({ card }: { card: SampleCard }) {
  const label = actionLabel(card);
  const passive = card.action === 'installed' || card.action === 'queued' || card.action === 'downloading';

  return (
    <button
      type="button"
      aria-label={`${label} ${card.title}`}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border text-xs shadow-[0_1px_5px_rgba(0,0,0,0.55)] transition-colors ${actionTone(
        card
      )} ${passive ? 'cursor-default' : ''}`}
    >
      {card.action === 'downloading' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : card.action === 'installed' || card.action === 'enable' ? (
        <Check className="h-4 w-4" />
      ) : card.action === 'queued' ? (
        <Clock className="h-4 w-4" />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </button>
  );
}

function ThumbnailAudioPreview({ card }: { card: SampleCard }) {
  if (card.kind !== 'sound') return null;

  return (
    <div className="absolute inset-x-2.5 bottom-2.5 flex h-9 items-center gap-2 rounded-sm border border-white/10 bg-bg-primary/92 px-2 text-text-secondary shadow-[0_2px_10px_rgba(0,0,0,0.55)]">
      <button
        type="button"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-bg-primary"
        aria-label={`Preview ${card.title}`}
      >
        <Play className="ml-0.5 h-3 w-3 fill-current" />
      </button>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
        <div className="h-full w-1/3 rounded-full bg-accent" />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-text-tertiary">{card.duration ?? '0:00'}</span>
    </div>
  );
}

function Thumbnail({ card }: { card: SampleCard }) {
  const nsfw = hasBadge(card, 'nsfw');

  return (
    <div className="relative h-40 overflow-hidden rounded-t-md bg-bg-tertiary">
      <img
        src={getHeroRenderPath(card.hero)}
        alt={card.hero}
        className={`h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02] ${
          nsfw ? 'scale-105 blur-lg saturate-75' : ''
        }`}
        style={heroStyle(card)}
      />

      {nsfw && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-primary/55 text-state-danger">
          <ShieldCheck className="h-5 w-5" />
          <span className="mt-1 text-[11px] font-semibold">NSFW hidden</span>
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="flex min-w-0 flex-wrap items-start gap-1.5 pr-1">
          <CategoryChip card={card} />
          <StatusChips card={card} />
        </div>
        <ActionButton card={card} />
      </div>

      <ThumbnailAudioPreview card={card} />
    </div>
  );
}

function StatsRow({ card }: { card: SampleCard }) {
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-text-secondary">
      <span className="inline-flex items-center gap-1 tabular-nums">
        <ThumbsUp className="h-3 w-3" />
        {card.likes}
      </span>
      <span className="inline-flex items-center gap-1 tabular-nums">
        <Eye className="h-3 w-3" />
        {card.views}
      </span>
      <span className="inline-flex items-center gap-1 tabular-nums">
        <Download className="h-3 w-3" />
        {card.downloads}
      </span>
    </div>
  );
}

function ProductModCard({ card }: { card: SampleCard }) {
  return (
    <article className="group flex h-[274px] w-[280px] flex-col overflow-hidden rounded-md border border-white/[0.07] bg-bg-secondary text-left shadow-[0_1px_0_rgba(255,255,255,0.03)] transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
      <Thumbnail card={card} />

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
        <div className="h-[58px] min-w-0 overflow-hidden">
          <h3 className="line-clamp-2 text-[0.95rem] font-semibold leading-snug text-text-primary">{card.title}</h3>
          <p className="mt-1 truncate text-xs text-text-tertiary">by {card.author}</p>
        </div>

        <div className="mt-auto flex h-5 items-center justify-between gap-3">
          <StatsRow card={card} />
          <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{card.date}</span>
        </div>
      </div>
    </article>
  );
}

function GridExample({
  title,
  description,
  cards,
}: {
  title: string;
  description: string;
  cards: SampleCard[];
}) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="font-reaver text-lg font-semibold text-text-primary">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">{description}</p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,280px)] justify-start gap-4">
        {cards.map((card) => (
          <ProductModCard key={card.id} card={card} />
        ))}
      </div>
    </section>
  );
}

export default function BrowseCardTestbed() {
  return (
    <div className="min-h-full bg-bg-primary text-text-primary">
      <div className="mx-auto flex w-full max-w-[932px] flex-col gap-8 px-5 py-6">
        <header className="border-b border-border pb-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 inline-flex items-center gap-2 rounded-sm border border-accent/30 bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">
                <Layers className="h-3.5 w-3.5" />
                Testbed example
              </p>
              <h1 className="font-reaver text-2xl font-semibold text-text-primary">Product UI mod card</h1>
              <p className="mt-2 max-w-3xl text-sm text-text-secondary">
                Production-like section grids. Mods and Sounds are shown separately because Browse does not mix them in one result grid.
              </p>
            </div>
            <div className="rounded-sm border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
              Route: #/browse-card-testbed
            </div>
          </div>
        </header>

        <GridExample
          title="Mods grid"
          description="No audio treatment. Tests normal, installed, NSFW hidden, and outdated states with the same fixed card geometry."
          cards={MOD_GRID_CARDS}
        />

        <GridExample
          title="Sounds grid"
          description="Every card has audio preview in the thumbnail. Body and footer stay identical to the Mods grid."
          cards={SOUND_GRID_CARDS}
        />
      </div>
    </div>
  );
}

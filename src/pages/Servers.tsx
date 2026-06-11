import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Server as ServerIcon,
  Users,
  MapPin,
  Lock,
  RefreshCw,
  Search,
  Signal,
  Loader2,
  Play,
  AlertTriangle,
  CloudOff,
  Globe2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Badge } from '../components/common/ui';
import { EmptyState, PageHeader } from '../components/common/PageComponents';
import { useAppStore } from '../stores/appStore';
import {
  deadworksListServers,
  deadworksRelayStats,
  deadworksPingServer,
  type DeadworksServer,
  type DeadworksRelayStats,
} from '../lib/api';
import ConnectServerDialog from '../components/servers/ConnectServerDialog';

// Ping buckets drive the colour of the signal readout. Tuned for a competitive
// shooter: under 60ms is comfortable, under 120ms is playable, beyond that hurts.
function pingTone(ms: number): { color: string; label: string } {
  if (ms < 0) return { color: 'text-text-secondary/50', label: 'n/a' };
  if (ms < 60) return { color: 'text-green-400', label: `${ms} ms` };
  if (ms < 120) return { color: 'text-yellow-400', label: `${ms} ms` };
  return { color: 'text-red-400', label: `${ms} ms` };
}

export default function Servers() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const hasGamePath = Boolean(settings?.deadlockPath || (settings?.devMode && settings?.devDeadlockPath));

  const [servers, setServers] = useState<DeadworksServer[]>([]);
  const [pings, setPings] = useState<Record<string, number>>({});
  const [stats, setStats] = useState<DeadworksRelayStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [region, setRegion] = useState<string>('all');
  const [mapFilter, setMapFilter] = useState<string>('all');
  const [hideFull, setHideFull] = useState(false);
  const [connectTarget, setConnectTarget] = useState<DeadworksServer | null>(null);

  const pingAll = useCallback((list: DeadworksServer[]) => {
    setPings({});
    for (const s of list) {
      if (!s.raw_address) continue;
      deadworksPingServer(s.raw_address)
        .then((ms) => setPings((prev) => ({ ...prev, [s.id]: ms })))
        .catch(() => setPings((prev) => ({ ...prev, [s.id]: -1 })));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, relayStats] = await Promise.all([
        deadworksListServers(),
        deadworksRelayStats(),
      ]);
      setServers(list);
      setStats(relayStats);
      pingAll(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the relay.');
    } finally {
      setLoading(false);
    }
  }, [pingAll]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const regions = useMemo(() => {
    const set = new Set<string>();
    for (const s of servers) if (s.region) set.add(s.region);
    return ['all', ...[...set].sort()];
  }, [servers]);

  const maps = useMemo(() => {
    const set = new Set<string>();
    for (const s of servers) if (s.map) set.add(s.map);
    return ['all', ...[...set].sort()];
  }, [servers]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers
      .filter((s) => (region === 'all' ? true : s.region === region))
      .filter((s) => (mapFilter === 'all' ? true : s.map === mapFilter))
      .filter((s) => (hideFull ? s.player_count < s.max_players : true))
      .filter((s) => (q ? s.name.toLowerCase().includes(q) || s.map.toLowerCase().includes(q) : true))
      .sort((a, b) => b.player_count - a.player_count || a.name.localeCompare(b.name));
  }, [servers, query, region, mapFilter, hideFull]);

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title={t('nav.servers')}
        description="Browse and join Deadworks community dedicated servers."
        stats={
          stats ? (
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <ServerIcon size={14} /> {stats.servers_online} online
              </span>
              <span className="flex items-center gap-1.5">
                <Users size={14} /> {stats.players_online} playing
              </span>
            </span>
          ) : undefined
        }
        action={
          <Button variant="secondary" icon={RefreshCw} onClick={() => void refresh()} isLoading={loading}>
            Refresh
          </Button>
        }
      />

      {!hasGamePath && (
        <div className="flex items-center gap-2 rounded-sm border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-300">
          <AlertTriangle size={16} className="shrink-0" />
          Set your Deadlock game path in Settings before joining a server.
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or map"
            className="w-full rounded-sm border border-border bg-bg-tertiary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60 focus:border-accent/50 focus:outline-none"
          />
        </div>

        {regions.length > 1 && (
          <div className="flex items-center gap-1.5 rounded-sm border border-border bg-bg-tertiary px-2 py-1.5">
            <Globe2 size={14} className="text-text-secondary" />
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="bg-transparent text-sm text-text-primary focus:outline-none"
            >
              {regions.map((r) => (
                <option key={r} value={r} className="bg-bg-secondary">
                  {r === 'all' ? 'All regions' : r}
                </option>
              ))}
            </select>
          </div>
        )}

        {maps.length > 1 && (
          <div className="flex items-center gap-1.5 rounded-sm border border-border bg-bg-tertiary px-2 py-1.5">
            <MapPin size={14} className="text-text-secondary" />
            <select
              value={mapFilter}
              onChange={(e) => setMapFilter(e.target.value)}
              className="bg-transparent text-sm text-text-primary focus:outline-none"
            >
              {maps.map((m) => (
                <option key={m} value={m} className="bg-bg-secondary">
                  {m === 'all' ? 'All maps' : m}
                </option>
              ))}
            </select>
          </div>
        )}

        <Button variant={hideFull ? 'primary' : 'secondary'} size="sm" onClick={() => setHideFull((v) => !v)}>
          Has space
        </Button>
      </div>

      {/* Content */}
      {loading && servers.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-20 text-text-secondary">
          <Loader2 size={18} className="animate-spin" /> Loading servers...
        </div>
      ) : error ? (
        <EmptyState
          icon={CloudOff}
          title="Could not reach the relay"
          description={error}
          action={<Button variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>Try again</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title={servers.length === 0 ? 'No servers online' : 'No servers match your filters'}
          description={
            servers.length === 0
              ? 'No Deadworks servers are currently registered. Check back later, or host one (server hosting requires Windows).'
              : 'Try clearing the search, region, or map filter.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {/* header row */}
          <div className="hidden grid-cols-[1fr_140px_90px_90px_110px] gap-3 border-b border-border bg-bg-secondary px-4 py-2 text-xs font-medium uppercase tracking-wide text-text-secondary md:grid">
            <span>Server</span>
            <span>Map</span>
            <span className="text-center">Players</span>
            <span className="text-center">Ping</span>
            <span className="text-right">Join</span>
          </div>
          <ul className="divide-y divide-border">
            {visible.map((s) => {
              const ping = pings[s.id];
              const tone = pingTone(ping ?? -1);
              const full = s.player_count >= s.max_players && s.max_players > 0;
              return (
                <li
                  key={s.id}
                  className="grid grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-white/[0.02] md:grid-cols-[1fr_140px_90px_90px_110px] md:items-center md:gap-3"
                >
                  {/* name + status */}
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${s.online ? 'bg-green-400' : 'bg-text-secondary/40'}`}
                      title={s.online ? 'Online' : 'Stale'}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-text-primary">{s.name}</span>
                        {s.password_protected && (
                          <span title="Password protected" className="inline-flex shrink-0">
                            <Lock size={13} className="text-text-secondary" />
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-text-secondary">
                        {s.region && <span className="flex items-center gap-1"><MapPin size={11} />{s.region}</span>}
                        {s.content && s.content.length > 0 && (
                          <Badge variant="info" className="!px-1.5 !py-0">{s.content.length} content</Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* map */}
                  <div className="truncate text-sm text-text-secondary md:text-text-primary" title={s.map}>
                    {s.map || '-'}
                  </div>

                  {/* players */}
                  <div className={`text-sm md:text-center ${full ? 'text-yellow-400' : 'text-text-primary'}`}>
                    <Users size={12} className="mr-1 inline md:hidden" />
                    {s.player_count}/{s.max_players}
                  </div>

                  {/* ping */}
                  <div className={`flex items-center gap-1 text-sm md:justify-center ${tone.color}`}>
                    <Signal size={13} />
                    {ping === undefined ? <Loader2 size={12} className="animate-spin" /> : tone.label}
                  </div>

                  {/* join */}
                  <div className="md:text-right">
                    <Button
                      variant="primary"
                      size="sm"
                      icon={Play}
                      disabled={!hasGamePath || full}
                      onClick={() => setConnectTarget(s)}
                      title={full ? 'Server is full' : !hasGamePath ? 'Set your game path first' : 'Join'}
                    >
                      Join
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {connectTarget && (
        <ConnectServerDialog server={connectTarget} onClose={() => setConnectTarget(null)} />
      )}
    </div>
  );
}

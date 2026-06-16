import { useMemo, type ReactNode } from 'react';
import { createSoulRegistry, SoulRegistryContext } from './soulRegistry';

/**
 * Provides the soul-container tile registry to the Locker's Global view. The
 * registry is created once and kept stable across re-renders so tile effects
 * never re-run on parent updates (e.g. opening the retag menu) and the shared
 * canvas keeps reading the same live map.
 */
export function SoulRegistryProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(() => createSoulRegistry(), []);
  return <SoulRegistryContext.Provider value={registry}>{children}</SoulRegistryContext.Provider>;
}

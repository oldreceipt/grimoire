import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';

/**
 * Drives Discord Rich Presence from the current route.
 *
 * Renders nothing. Mounted inside Layout (so it lives under the Router and can
 * read the active route). On navigation it reports a tiny context object to the
 * main process, which owns all the presence wording, art, and rate limiting.
 *
 * When the user turns the feature off it tells the main process to clear the
 * presence and disconnect. The main process no-ops everything while the feature
 * is dormant (no Discord Application ID configured) or while Discord isn't
 * running, so this component can stay dumb: report on change, clear when off.
 */
export default function DiscordPresence() {
    const location = useLocation();
    const enabled = useAppStore((s) => s.settings?.discordRpcEnabled ?? false);
    const modCount = useAppStore((s) => s.mods.length);
    // The hero currently open in the Locker, published by the Locker page.
    const lockerHero = useAppStore((s) => s.lockerHeroName);

    // First path segment is the surface: '' -> installed, 'browse', 'locker'...
    const surface = location.pathname.split('/')[1] || 'installed';
    // Only attach the hero when we're actually on the Locker surface.
    const hero = surface === 'locker' ? lockerHero ?? undefined : undefined;

    // Push a presence update on navigation while enabled. Debounced so flipping
    // quickly between tabs sends one update, not many (the main process throttles
    // again as a backstop under Discord's 5-updates-per-20s limit).
    useEffect(() => {
        if (!enabled) return;
        const t = setTimeout(() => {
            void window.electronAPI.discord.update({ surface, count: modCount, hero });
        }, 800);
        return () => clearTimeout(t);
    }, [enabled, surface, modCount, hero]);

    // Clear + disconnect when the feature is turned off (the cleanup runs on the
    // enabled -> disabled transition) or on unmount while it was on. Stays silent
    // while disabled, so the default-off case sends nothing.
    useEffect(() => {
        if (!enabled) return;
        return () => {
            void window.electronAPI.discord.clear();
        };
    }, [enabled]);

    return null;
}

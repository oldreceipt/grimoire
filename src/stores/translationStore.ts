import { create } from 'zustand';
import {
  getTranslationCatalog,
  registerTranslationContributor,
  saveTranslationSuggestion,
  type TranslationCatalogRow,
} from '../lib/api';

interface TranslationStore {
  enabled: boolean;
  signedIn: boolean;
  languageCode: string | null;
  rowsByKey: Record<string, TranslationCatalogRow>;
  localOverrides: Record<string, string>;
  savingKeys: Record<string, boolean>;
  savedKeys: Record<string, boolean>;
  errors: Record<string, string>;
  catalogLoading: boolean;
  catalogLoadedLanguage: string | null;
  catalogError: string | null;
  registered: boolean;
  registrationError: string | null;

  configure: (next: { enabled: boolean; signedIn: boolean; languageCode: string | null }) => void;
  registerContributor: () => Promise<void>;
  loadCatalog: (languageCode?: string) => Promise<void>;
  saveSuggestion: (args: {
    key: string;
    source: string;
    value: string;
    contextRoute?: string;
    appVersion?: string;
  }) => Promise<boolean>;
}

export const useTranslationStore = create<TranslationStore>((set, get) => ({
  enabled: false,
  signedIn: false,
  languageCode: null,
  rowsByKey: {},
  localOverrides: {},
  savingKeys: {},
  savedKeys: {},
  errors: {},
  catalogLoading: false,
  catalogLoadedLanguage: null,
  catalogError: null,
  registered: false,
  registrationError: null,

  configure: (next) => {
    const prev = get();
    const resetCatalog = prev.languageCode !== next.languageCode || !next.enabled || !next.signedIn;
    set({
      enabled: next.enabled,
      signedIn: next.signedIn,
      languageCode: next.languageCode,
      ...(resetCatalog
        ? {
            rowsByKey: {},
            localOverrides: {},
            savingKeys: {},
            savedKeys: {},
            errors: {},
            catalogLoading: false,
            catalogLoadedLanguage: null,
            catalogError: null,
            registered: false,
            registrationError: null,
          }
        : {}),
    });
  },

  registerContributor: async () => {
    const state = get();
    if (!state.enabled || !state.signedIn || state.registered) return;
    try {
      await registerTranslationContributor();
      set({ registered: true, registrationError: null });
    } catch (err) {
      set({ registrationError: err instanceof Error ? err.message : String(err) });
    }
  },

  loadCatalog: async (languageCode = get().languageCode ?? undefined) => {
    if (!languageCode) return;
    const state = get();
    if (!state.enabled || !state.signedIn) return;
    if (state.catalogLoading || state.catalogLoadedLanguage === languageCode) return;

    set({ catalogLoading: true, catalogError: null });
    try {
      const catalog = await getTranslationCatalog(languageCode);
      set({
        rowsByKey: Object.fromEntries(catalog.rows.map((row) => [row.key, row])),
        catalogLoadedLanguage: catalog.languageCode,
      });
    } catch (err) {
      set({ catalogError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ catalogLoading: false });
    }
  },

  saveSuggestion: async ({ key, source, value, contextRoute, appVersion }) => {
    const state = get();
    const languageCode = state.languageCode;
    if (!state.enabled || !state.signedIn || !languageCode) return false;

    set((prev) => ({
      localOverrides: { ...prev.localOverrides, [key]: value },
      savingKeys: { ...prev.savingKeys, [key]: true },
      savedKeys: { ...prev.savedKeys, [key]: false },
      errors: clearKey(prev.errors, key),
    }));

    try {
      await saveTranslationSuggestion({
        languageCode,
        key,
        value,
        source,
        contextRoute,
        appVersion,
      });
      set((prev) => ({
        rowsByKey: {
          ...prev.rowsByKey,
          ...(prev.rowsByKey[key]
            ? { [key]: { ...prev.rowsByKey[key], value, status: 'draft' } }
            : {}),
        },
        savingKeys: { ...prev.savingKeys, [key]: false },
        savedKeys: { ...prev.savedKeys, [key]: true },
      }));
      window.setTimeout(() => {
        useTranslationStore.setState((prev) => ({
          savedKeys: { ...prev.savedKeys, [key]: false },
        }));
      }, 1400);
      return true;
    } catch (err) {
      set((prev) => ({
        savingKeys: { ...prev.savingKeys, [key]: false },
        errors: {
          ...prev.errors,
          [key]: err instanceof Error ? err.message : String(err),
        },
      }));
      return false;
    }
  },
}));

function clearKey(map: Record<string, string>, key: string): Record<string, string> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

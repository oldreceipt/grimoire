import { useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSocialStore } from '../../stores/socialStore';
import { useTranslationStore } from '../../stores/translationStore';

export default function TranslationModeBridge() {
  const enabled = useAppStore((s) => s.settings?.experimentalTranslationMode ?? false);
  const languageCode = useAppStore((s) => s.settings?.translationModeLanguage?.trim() || null);
  const signedIn = useSocialStore((s) => s.status.signedIn);
  const configure = useTranslationStore((s) => s.configure);
  const loadCatalog = useTranslationStore((s) => s.loadCatalog);
  const registerContributor = useTranslationStore((s) => s.registerContributor);

  useEffect(() => {
    configure({ enabled, signedIn, languageCode });
  }, [configure, enabled, languageCode, signedIn]);

  useEffect(() => {
    if (enabled && signedIn && languageCode) {
      void loadCatalog(languageCode);
    }
  }, [enabled, languageCode, loadCatalog, signedIn]);

  useEffect(() => {
    if (enabled && signedIn) {
      void registerContributor();
    }
  }, [enabled, registerContributor, signedIn]);

  return null;
}

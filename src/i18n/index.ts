/**
 * i18n initialization (Phase 1.5.1).
 *
 * Side-effecting module — import once from main.tsx before any component
 * uses `useTranslation`. Subsequent imports are no-ops because i18next
 * stores a singleton internally.
 *
 * Detection order (i18next-browser-languagedetector defaults):
 *   1. localStorage 'i18nextLng' (if user previously picked one)
 *   2. navigator.language (browser preference)
 *   3. 'en' (fallback)
 *
 * Tamil ('ta') is the only non-English locale today. Anything else falls
 * through to 'en' via fallbackLng.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en.json';
import taCommon from './locales/ta.json';
import { ensureTamilFontLoaded } from './tamilFont';

export const SUPPORTED_LANGUAGES = ['en', 'ta'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: enCommon,
      ta: taCommon,
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    // We split strings into per-feature top-level keys (auth, common, …) and
    // address them via `t('auth.tabLogin')` rather than namespaces. Keeps
    // the loader simple — one JSON per language, no per-namespace fetches.
    defaultNS: 'translation',
    interpolation: {
      escapeValue: false,                 // React already escapes JSX output
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'i18nextLng',
      caches: ['localStorage'],
    },
    // 'cimode' returns the key itself — useful when chasing missing strings
    // in the dev console; flip via `?lng=cimode` in the URL.
    react: {
      useSuspense: false,                 // no Suspense boundary — strings ship in-bundle
    },
  });

// Load Noto Sans Tamil whenever Tamil becomes (or is already) active.
// Doing it inside i18n.init's `then` handler doesn't work — DetectionPlugin
// resolves the language synchronously, so we read it eagerly and also wire
// the change listener for switches at runtime.
if (i18n.language?.startsWith('ta')) ensureTamilFontLoaded();
i18n.on('languageChanged', (lng: string) => {
  if (lng?.startsWith('ta')) ensureTamilFontLoaded();
});

export default i18n;

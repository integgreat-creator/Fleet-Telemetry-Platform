import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';

// ─── Component ───────────────────────────────────────────────────────────────

/// Two-state language toggle (English / தமிழ்) shipped in the Layout
/// sidebar bottom. Phase 1.5.1.
///
/// Compact-by-default segmented control. The selected option is filled,
/// the other is muted — same idiom as the Monthly/Annual toggle in
/// PlanCheckoutModal so customers don't learn a new pattern.
///
/// Persistence: i18next-browser-languagedetector caches the choice in
/// localStorage('i18nextLng') automatically. We don't need to do anything
/// here beyond `i18n.changeLanguage()`.
export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  // Normalise — i18n.language can come back as 'en-US' from browser detection
  // even though we only ship 'en' resources. Strip the region for comparison.
  const current: SupportedLanguage =
    SUPPORTED_LANGUAGES.find(l => i18n.language?.startsWith(l)) ?? 'en';

  const handleSelect = (lng: SupportedLanguage) => {
    if (lng === current) return;
    void i18n.changeLanguage(lng);
  };

  return (
    <div className="px-3 py-3 border-t border-gray-800">
      <div className="flex items-center gap-2 mb-2 px-1">
        <Globe size={11} className="text-gray-500 flex-shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          Language
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="Language"
        className="grid grid-cols-2 gap-1 p-1 bg-gray-800/60 border border-gray-800 rounded-lg"
      >
        <button
          role="radio"
          aria-checked={current === 'en'}
          onClick={() => handleSelect('en')}
          className={`py-1.5 rounded-md text-xs font-medium transition-colors ${
            current === 'en'
              ? 'bg-gray-700 text-white shadow-inner'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {t('common.languageEnglish')}
        </button>
        <button
          role="radio"
          aria-checked={current === 'ta'}
          onClick={() => handleSelect('ta')}
          className={`py-1.5 rounded-md text-xs font-medium transition-colors ${
            current === 'ta'
              ? 'bg-gray-700 text-white shadow-inner'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {t('common.languageTamil')}
        </button>
      </div>
    </div>
  );
}

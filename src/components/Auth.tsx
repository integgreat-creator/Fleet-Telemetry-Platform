import { useState, useRef } from 'react';
import { Car } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';

// ─── Acquisition capture (Phase 4.1) ────────────────────────────────────────

/// URL params we capture for acquisition attribution. Reads happen ONCE on
/// component mount so a user who navigates inside the auth screen (toggling
/// login/signup) doesn't lose the attribution if we later do client-side
/// route changes that drop the query string.
///
/// We deliberately don't strip the params from the URL — leaving them lets
/// the user share their post-signup link with attribution intact, and also
/// makes the capture easier to debug (the params are visible in the URL
/// while developing). The server-side classifier is the source of truth.
function readAcquisitionFromUrl(): Record<string, string> | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    for (const k of ['ref', 'utm_source', 'utm_medium', 'utm_campaign',
                     'utm_content', 'utm_term'] as const) {
      const v = params.get(k);
      if (v) out[k] = v.slice(0, 200);   // hard cap; server caps too, belt+braces
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    // URL parsing should never throw on a real browser, but if it does
    // (e.g. a quirky embedded webview), failing closed is the right call:
    // the worst case is acquisition=direct, which the migration backfill
    // already does for older rows.
    return null;
  }
}

export default function Auth() {
  const { t, i18n } = useTranslation();

  // Pre-login language toggle — the sidebar switcher only appears AFTER auth,
  // so a Tamil-preferring user landing on the signup screen needs an in-page
  // override here. Pure presentation, no copy of LanguageSwitcher's chrome —
  // just two buttons stacked into the auth card footer.
  const currentLang: SupportedLanguage =
    SUPPORTED_LANGUAGES.find(l => i18n.language?.startsWith(l)) ?? 'en';
  const handleLangSelect = (lng: SupportedLanguage) => {
    if (lng !== currentLang) void i18n.changeLanguage(lng);
  };
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fleetName, setFleetName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Snapshot URL params at first render — capture on mount, hold across
  // re-renders. useRef instead of useState because we don't want a render
  // when these change (they don't change after mount). Phase 4.1.
  const acquisitionRef = useRef<Record<string, string> | null>(null);
  if (acquisitionRef.current === null) {
    acquisitionRef.current = readAcquisitionFromUrl();
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      } else {
        if (!fleetName.trim()) {
          throw new Error(t('auth.errorFleetNameRequired'));
        }

        // Use the fleet-signup edge function which uses the service role to:
        // 1. Create the auth user (email pre-confirmed)
        // 2. Create the fleet record atomically
        // 3. Sign in and return a session
        let res: Response;
        try {
          res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fleet-signup`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                email:      email.trim().toLowerCase(),
                password,
                fleet_name: fleetName.trim(),
                // Phase 1.8.1 — capture the language the customer chose on
                // the pre-login switcher (or that browser detection picked)
                // so the freshly-created fleet row has preferred_language
                // set from the start. Saves them having to re-toggle inside
                // the dashboard to "lock in" their reminder language.
                preferred_language: currentLang,
                // Phase 4.1 — pass any URL params captured at signup so the
                // server-side classifier can bucket the acquisition source.
                // null when nothing relevant was in the URL — server falls
                // back to source='direct' in that case.
                acquisition: acquisitionRef.current ?? undefined,
              }),
            }
          );
        } catch {
          throw new Error(t('auth.errorNetwork'));
        }

        let body: any;
        try {
          body = await res.json();
        } catch {
          throw new Error(t('auth.errorServerWithStatus', { status: res.status }));
        }

        if (!res.ok) {
          throw new Error(body?.error || t('auth.errorSignUpFailed', { status: res.status }));
        }

        // Edge function created the account + fleet.
        // Sign in client-side — this is the only path that reliably fires
        // onAuthStateChange and loads the dashboard. setSession() is unreliable
        // across browsers and doesn't consistently trigger the auth state listener.
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email:    email.trim().toLowerCase(),
          password,
        });
        if (signInError) {
          throw new Error(t('auth.errorPostSignUpSignIn'));
        }
      }
    } catch (err: any) {
      setError(err.message || t('common.errorGeneric'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center space-x-3 mb-4">
            <Car className="w-12 h-12 text-blue-500" />
            <h1 className="text-4xl font-bold text-white">{t('auth.appName')}</h1>
          </div>
          <p className="text-gray-400">{t('auth.tagline')}</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-8 border border-gray-800">
          <div className="flex space-x-2 mb-6">
            <button
              onClick={() => setIsLogin(true)}
              className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                isLogin
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {t('auth.tabLogin')}
            </button>
            <button
              onClick={() => setIsLogin(false)}
              className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                !isLogin
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {t('auth.tabSignUp')}
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">{t('auth.labelFleetName')}</label>
                <input
                  type="text"
                  required
                  value={fleetName}
                  onChange={(e) => setFleetName(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  placeholder={t('auth.placeholderFleetName')}
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">{t('auth.labelEmail')}</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder={t('auth.placeholderEmail')}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">{t('auth.labelPassword')}</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder={t('auth.placeholderPassword')}
                minLength={6}
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/50 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
            >
              {loading
                ? t('auth.submitLoading')
                : isLogin ? t('auth.submitLogin') : t('auth.submitSignUp')}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-gray-800">
            <p className="text-xs text-gray-500 text-center">
              {isLogin ? t('auth.switchToSignUpPrompt') : t('auth.switchToLoginPrompt')}{' '}
              <button
                onClick={() => setIsLogin(!isLogin)}
                className="text-blue-500 hover:text-blue-400"
              >
                {isLogin ? t('auth.switchToSignUpAction') : t('auth.switchToLoginAction')}
              </button>
            </p>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-gray-500">
          <p>{t('auth.demoFooter')}</p>
        </div>

        {/* Pre-login language switcher (Phase 1.5.1) — same idiom as the
            sidebar version but inlined here because the sidebar isn't
            mounted yet. */}
        <div className="mt-4 flex items-center justify-center gap-1 text-xs">
          {SUPPORTED_LANGUAGES.map((lng, i) => (
            <span key={lng} className="contents">
              {i > 0 && <span className="text-gray-700">·</span>}
              <button
                onClick={() => handleLangSelect(lng)}
                className={`px-2 py-1 rounded transition-colors ${
                  currentLang === lng
                    ? 'text-white font-semibold'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
                aria-pressed={currentLang === lng}
              >
                {lng === 'en' ? t('common.languageEnglish') : t('common.languageTamil')}
              </button>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

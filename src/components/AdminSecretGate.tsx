import { useState, type ReactNode } from 'react';
import { Lock, KeyRound, X } from 'lucide-react';

// ─── Constants ───────────────────────────────────────────────────────────────

/// sessionStorage key for the operator's admin secret. Cleared on tab close,
/// not just on lock-button click — operators sharing a machine don't leak
/// the secret to whoever opens the next browser session.
const SESSION_KEY = 'ftpgo_admin_secret';

// ─── Hook: read + persist the admin secret ───────────────────────────────────

/// Tiny self-contained store for the admin secret. Components rendered inside
/// the gate read this directly via `useAdminSecret`; everyone else need not
/// know the gate exists.
export function useAdminSecret(): string | null {
  // Read on every render (no useEffect) — sessionStorage is sync and cheap.
  // Returning `null` lets consumers branch into a "no secret yet" state.
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(SESSION_KEY);
}

function setAdminSecret(secret: string | null) {
  if (typeof window === 'undefined') return;
  if (secret) window.sessionStorage.setItem(SESSION_KEY, secret);
  else        window.sessionStorage.removeItem(SESSION_KEY);
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  /// Rendered only when the operator has entered (and the server has not
  /// yet rejected) a secret.
  children: ReactNode;
  /// Optional hook for the consumer page to clear cached data when the
  /// operator locks the dashboard. e.g. wipe MRR figures so a new operator
  /// loading the same tab doesn't briefly see numbers that aren't theirs.
  onLock?: () => void;
}

/// Operator-only gate that's hidden from customers. Customers who somehow
/// reach the page see a "Restricted area" prompt; operators paste their
/// secret once per session and are let through.
///
/// The secret is stored in sessionStorage, so it survives nav within the
/// SPA but evaporates on tab close. Edge functions still validate the
/// secret server-side on every call — the gate is purely UX so the page
/// doesn't show a "403 Forbidden" toast on the first paint.
export default function AdminSecretGate({ children, onLock }: Props) {
  const [secret, setSecretState] = useState<string | null>(useAdminSecret());
  const [draft,  setDraft]       = useState('');
  const [error,  setError]       = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('Enter your admin secret.');
      return;
    }
    setAdminSecret(trimmed);
    setSecretState(trimmed);
    setDraft('');
    setError(null);
  };

  const handleLock = () => {
    setAdminSecret(null);
    setSecretState(null);
    onLock?.();
  };

  if (!secret) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2.5 text-yellow-400">
            <Lock size={16} />
            <h1 className="text-sm font-semibold uppercase tracking-widest">Operator only</h1>
          </div>
          <p className="text-sm text-gray-400 leading-relaxed">
            This page is restricted to FTPGo operators. Enter your admin secret
            to continue. The secret is stored only for this browser tab.
          </p>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">
              Admin secret
            </label>
            <input
              type="password"
              value={draft}
              onChange={e => { setDraft(e.target.value); setError(null); }}
              autoFocus
              autoComplete="off"
              className={`w-full bg-gray-800 border rounded-lg px-3 py-2.5 text-sm font-mono text-white focus:outline-none focus:ring-2 ${
                error
                  ? 'border-red-700 focus:ring-red-500/40'
                  : 'border-gray-700 focus:ring-yellow-500/40 focus:border-yellow-600'
              }`}
            />
            {error && (
              <p className="mt-1 text-[11px] text-red-400">{error}</p>
            )}
          </div>
          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            <KeyRound size={14} />
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Lock-out toolbar — small, non-intrusive. Operators sharing a
          machine click this on their way out. */}
      <div className="flex items-center justify-end">
        <button
          onClick={handleLock}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-gray-500 hover:text-gray-300 border border-gray-800 rounded-md hover:border-gray-700 transition-colors"
        >
          <X size={11} />
          Lock dashboard
        </button>
      </div>
      {children}
    </div>
  );
}

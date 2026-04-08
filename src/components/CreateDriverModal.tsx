import { useState } from 'react';
import { X, UserPlus, Copy, Check, Eye, EyeOff, Loader } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
  fleetId: string;
  onClose: () => void;
  onDriverCreated: () => void;
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => chars[b % chars.length])
    .join('');
}

export default function CreateDriverModal({ fleetId, onClose, onDriverCreated }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState(generatePassword);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Success state
  const [created, setCreated] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  const copy = (text: string, which: 'email' | 'password') => {
    navigator.clipboard.writeText(text);
    if (which === 'email') {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    } else {
      setCopiedPassword(true);
      setTimeout(() => setCopiedPassword(false), 2000);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Proactively refresh session so invoke() always sends a valid JWT
      await supabase.auth.refreshSession();

      // Use supabase.functions.invoke() — it handles auth headers internally
      const { data, error: fnErr } = await supabase.functions.invoke('driver-management', {
        body: {
          action:   'create',
          name:     name.trim(),
          email:    email.trim().toLowerCase(),
          password,
          phone:    phone.trim() || undefined,
          fleet_id: fleetId,
        },
      });

      if (fnErr) {
        // Extract the real error body from FunctionsHttpError.context
        let msg = fnErr.message ?? 'Failed to create driver';
        try {
          const errBody = await (fnErr as any).context?.json?.();
          msg = errBody?.error ?? errBody?.message ?? msg;
        } catch { /* context not parseable — use fnErr.message */ }
        console.error('[CreateDriver] edge function error', fnErr, msg);
        throw new Error(msg);
      }

      console.log('[CreateDriver] success', data);
      setCreated(true);
      onDriverCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create driver');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Create Driver Account</h2>
            <p className="text-sm text-gray-400 mt-0.5">Driver uses these credentials to log in</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Success state ─────────────────────────────────────────── */}
        {created ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <Check className="w-6 h-6 text-green-400" />
              </div>
              <p className="text-white font-semibold">Driver account created</p>
              <p className="text-gray-400 text-sm text-center">
                Share these credentials with <span className="text-white">{name}</span>
              </p>
            </div>

            <div className="bg-yellow-900/30 border border-yellow-700/40 rounded-xl px-4 py-3 text-xs text-yellow-300">
              ⚠ Password will not be shown again. Copy it now.
            </div>

            {/* Email */}
            <div className="bg-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Email</p>
                <p className="text-white text-sm font-mono">{email}</p>
              </div>
              <button onClick={() => copy(email, 'email')} className="text-gray-400 hover:text-white ml-3">
                {copiedEmail ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {/* Password */}
            <div className="bg-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Password</p>
                <p className="text-white text-sm font-mono">{password}</p>
              </div>
              <button onClick={() => copy(password, 'password')} className="text-gray-400 hover:text-white ml-3">
                {copiedPassword ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          /* ── Form ────────────────────────────────────────────────── */
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Driver Name *</label>
              <input
                type="text"
                required
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Ravi Kumar"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Email *</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="ravi@driver.com"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Phone (optional)</label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono placeholder-gray-500 focus:outline-none focus:border-blue-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-gray-500">Auto-generated — edit if needed. Share with driver after creation.</p>
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-900/20 border border-red-700/40 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {loading ? <Loader className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {loading ? 'Creating…' : 'Create Account'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

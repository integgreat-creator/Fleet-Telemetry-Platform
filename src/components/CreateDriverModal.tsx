import { useState, useRef } from 'react';
import { X, UserPlus, Copy, Check, Eye, EyeOff, Loader, Download, Share2, Lock, ArrowRight } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { supabase } from '../lib/supabase';

interface Props {
  fleetId: string;
  onClose: () => void;
  onDriverCreated: () => void;
  onNavigateToAdmin?: () => void;
}

// Returned by check_driver_limit()
interface LimitCheck {
  allowed: boolean;
  reason?: string;
  limit?: number;
  used?: number;
  plan?: string;
}

const PLAN_DISPLAY: Record<string, string> = {
  trial:        'Trial',
  essential:    'Essential',
  professional: 'Professional',
  business:     'Business',
  enterprise:   'Enterprise',
  // Legacy plan names retained as fallbacks for existing rows
  starter:      'Starter',
  growth:       'Growth',
  pro:          'Pro',
};

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => chars[b % chars.length])
    .join('');
}

export default function CreateDriverModal({ fleetId, onClose, onDriverCreated, onNavigateToAdmin }: Props) {
  const [name,         setName]         = useState('');
  const [email,        setEmail]        = useState('');
  const [phone,        setPhone]        = useState('');
  const [password,     setPassword]     = useState(generatePassword);
  const [showPassword, setShowPassword] = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [limitBlocked, setLimitBlocked] = useState<LimitCheck | null>(null);

  // Success state
  const [created,        setCreated]        = useState(false);
  const [createdToken,   setCreatedToken]   = useState<string | null>(null);
  const [copiedEmail,    setCopiedEmail]    = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [copiedLink,     setCopiedLink]     = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  const copy = (text: string, which: 'email' | 'password' | 'link') => {
    navigator.clipboard.writeText(text);
    if (which === 'email')    { setCopiedEmail(true);    setTimeout(() => setCopiedEmail(false),    2000); }
    if (which === 'password') { setCopiedPassword(true); setTimeout(() => setCopiedPassword(false), 2000); }
    if (which === 'link')     { setCopiedLink(true);     setTimeout(() => setCopiedLink(false),     2000); }
  };

  const downloadQr = () => {
    const canvas = qrRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `vehiclesense-qr-${name.trim().replace(/\s+/g, '-').toLowerCase()}.png`;
    a.click();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setLimitBlocked(null);

    try {
      // ── Check driver limit before creating ────────────────────────────────
      const { data: limitData, error: limitErr } = await supabase
        .rpc('check_driver_limit', { p_fleet_id: fleetId });

      if (limitErr) throw new Error(limitErr.message);

      const check = limitData as LimitCheck;
      if (!check.allowed) {
        setLimitBlocked(check);
        return;
      }

      // ── Limit OK — proceed with creation ──────────────────────────────────
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token ?? null;
      if (!accessToken) throw new Error('Not authenticated — please log in again');

      const { data, error: fnErr } = await supabase.functions.invoke('driver-management', {
        headers: { Authorization: `Bearer ${accessToken}` },
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
        let msg = fnErr.message ?? 'Failed to create driver';
        try {
          const errBody = await (fnErr as any).context?.json?.();
          msg = errBody?.error ?? errBody?.message ?? msg;
        } catch { /* context not parseable — use fnErr.message */ }
        console.error('[CreateDriver] edge function error', fnErr, msg);
        throw new Error(msg);
      }

      console.log('[CreateDriver] success', data);
      setCreatedToken(data?.one_time_token ?? null);
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

        {/* ── Driver limit blocked state ─────────────────────────────────── */}
        {limitBlocked && (
          <div className="space-y-4">
            {/* Lock icon */}
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="w-14 h-14 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center">
                <Lock className="w-7 h-7 text-gray-400" />
              </div>
              <div className="text-center">
                <p className="text-white font-semibold text-base">Driver limit reached</p>
                <p className="text-gray-400 text-sm mt-1 max-w-xs leading-relaxed">
                  {limitBlocked.reason ?? 'You have reached the maximum number of drivers on your current plan.'}
                </p>
              </div>
            </div>

            {/* Usage bar */}
            {limitBlocked.limit != null && limitBlocked.used != null && limitBlocked.limit > 0 && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>Drivers used</span>
                  <span className="text-red-400 font-semibold">
                    {limitBlocked.used} / {limitBlocked.limit}
                  </span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                  <div className="h-2 rounded-full bg-red-500 transition-all" style={{ width: '100%' }} />
                </div>
              </div>
            )}

            {/* Plan badge */}
            {limitBlocked.plan && (
              <div className="flex items-center justify-center">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-800 text-gray-400 border border-gray-700">
                  {PLAN_DISPLAY[limitBlocked.plan] ?? limitBlocked.plan} plan
                </span>
              </div>
            )}

            {/* CTA */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                Close
              </button>
              {onNavigateToAdmin && (
                <button
                  onClick={() => { onNavigateToAdmin(); onClose(); }}
                  className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                >
                  Upgrade Plan
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Success state ─────────────────────────────────────────────── */}
        {!limitBlocked && created && (
          <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
            {/* Header */}
            <div className="flex flex-col items-center gap-2 py-1">
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
              <button onClick={() => copy(email, 'email')} className="text-gray-400 hover:text-white ml-3 flex-shrink-0">
                {copiedEmail ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {/* Password */}
            <div className="bg-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Password</p>
                <p className="text-white text-sm font-mono">{password}</p>
              </div>
              <button onClick={() => copy(password, 'password')} className="text-gray-400 hover:text-white ml-3 flex-shrink-0">
                {copiedPassword ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {/* QR Code */}
            {createdToken ? (
              <div className="bg-gray-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Login QR Code</p>
                    <p className="text-xs text-gray-500 mt-0.5">Driver scans this to log in instantly · valid 7 days · one-time use</p>
                  </div>
                </div>

                {/* QR canvas */}
                <div className="flex justify-center">
                  <div className="bg-white p-3 rounded-xl inline-block">
                    <QRCodeCanvas
                      ref={qrRef}
                      value={`vehiclesense://auth?token=${createdToken}`}
                      size={180}
                      bgColor="#ffffff"
                      fgColor="#000000"
                      level="M"
                    />
                  </div>
                </div>

                {/* Share & Download row */}
                <div className="flex gap-2">
                  <button
                    onClick={() => copy(`vehiclesense://auth?token=${createdToken}`, 'link')}
                    className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium transition-colors"
                  >
                    {copiedLink
                      ? <><Check className="w-3.5 h-3.5 text-green-400" /> Copied</>
                      : <><Share2 className="w-3.5 h-3.5" /> Copy Link</>}
                  </button>
                  <button
                    onClick={downloadQr}
                    className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> Download QR
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3 text-xs text-gray-500 text-center">
                QR code unavailable — run migration 20260415 in Supabase to enable it
              </div>
            )}

            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {/* ── Form ──────────────────────────────────────────────────────── */}
        {!limitBlocked && !created && (
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
                {loading ? 'Checking…' : 'Create Account'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

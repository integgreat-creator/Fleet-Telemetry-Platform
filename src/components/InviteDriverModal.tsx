import { useState, useEffect, useRef } from 'react';
import { X, QrCode, Copy, Check, RefreshCw, Loader } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../lib/supabase';

interface Props {
  fleetId: string;
  onClose: () => void;
  onVehicleCreated: () => void;
}

type Step = 'form' | 'qr';

export default function InviteDriverModal({ fleetId, onClose, onVehicleCreated }: Props) {
  const [step, setStep] = useState<Step>('form');
  const [vehicleName, setVehicleName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [driverEmail, setDriverEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // QR step state
  const [inviteUrl, setInviteUrl] = useState('');
  const [token, setToken] = useState('');
  const [pollStatus, setPollStatus] = useState<'pending' | 'accepted'>('pending');
  const [copied, setCopied] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start polling when we get to the QR step
  useEffect(() => {
    if (step !== 'qr' || !token) return;

    pollRef.current = setInterval(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-api?action=poll&token=${token}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'accepted') {
            setPollStatus('accepted');
            clearInterval(pollRef.current!);
            onVehicleCreated();
          }
        }
      } catch { /* ignore */ }
    }, 5000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, token, onVehicleCreated]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-api`,
        {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            Authorization:   `Bearer ${session.access_token}`,
            apikey:          import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            action:        'create',
            vehicle_name:  vehicleName.trim(),
            driver_phone:  driverPhone.trim(),
            driver_email:  driverEmail.trim() || undefined,
            fleet_id:      fleetId,
          }),
        }
      );

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to create invite');

      setToken(body.token);
      setInviteUrl(body.invite_url);
      setStep('qr');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create invite');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerate = async () => {
    setStep('form');
    setPollStatus('pending');
    setToken('');
    setInviteUrl('');
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">
              {step === 'form' ? 'QR Invite Driver' : 'Share QR Code'}
            </h2>
            <p className="text-sm text-gray-400 mt-0.5">
              {step === 'form'
                ? 'Driver will scan this to join your fleet'
                : 'Driver scans this with the VehicleSense app'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Step 1: Form ──────────────────────────────────────────── */}
        {step === 'form' && (
          <form onSubmit={handleSendInvite} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Vehicle Label *</label>
              <input
                type="text"
                required
                value={vehicleName}
                onChange={e => setVehicleName(e.target.value)}
                placeholder="e.g. Truck 04"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-500">Friendly name shown on the dashboard</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Driver Phone *</label>
              <input
                type="tel"
                required
                value={driverPhone}
                onChange={e => setDriverPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Driver Email (optional)</label>
              <input
                type="email"
                value={driverEmail}
                onChange={e => setDriverEmail(e.target.value)}
                placeholder="driver@example.com"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
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
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {loading ? <Loader className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                {loading ? 'Creating…' : 'Generate QR'}
              </button>
            </div>
          </form>
        )}

        {/* ── Step 2: QR ───────────────────────────────────────────── */}
        {step === 'qr' && (
          <div className="space-y-4">
            {pollStatus === 'accepted' ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
                  <Check className="w-8 h-8 text-green-400" />
                </div>
                <p className="text-white font-semibold text-lg">Driver Joined!</p>
                <p className="text-gray-400 text-sm text-center">
                  <span className="text-white font-medium">{vehicleName}</span> has been added to your fleet.
                </p>
                <button
                  onClick={onClose}
                  className="w-full py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {/* QR Code */}
                <div className="flex flex-col items-center bg-white rounded-2xl p-5 gap-3">
                  <QRCodeSVG value={inviteUrl} size={200} level="M" includeMargin={false} />
                  <p className="text-xs text-gray-500 text-center">
                    Driver scans with VehicleSense app to join <span className="font-medium text-gray-700">{vehicleName}</span>
                  </p>
                </div>

                {/* Status */}
                <div className="flex items-center gap-2 justify-center text-sm text-gray-400">
                  <Loader className="w-3.5 h-3.5 animate-spin" />
                  Waiting for driver to accept…
                </div>

                {/* Copy link */}
                <button
                  onClick={handleCopy}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium transition-colors"
                >
                  {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied!' : 'Copy invite link'}
                </button>

                {/* Regenerate */}
                <button
                  onClick={handleRegenerate}
                  className="w-full flex items-center justify-center gap-2 py-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Generate new QR (invalidates current)
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

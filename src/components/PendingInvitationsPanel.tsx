import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Clock, RefreshCw, Phone, Mail, QrCode, X, Loader } from 'lucide-react';

interface Invitation {
  id: string;
  invite_token: string;
  vehicle_name: string;
  driver_phone: string;
  driver_email: string | null;
  status: string;
  expires_at: string;
  created_at: string;
}

interface Props {
  fleetId: string;
  onResendQR: (token: string, vehicleName: string, driverPhone: string) => void;
}

export default function PendingInvitationsPanel({ fleetId, onResendQR }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [revoking,    setRevoking]    = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('invitations')
      .select('*')
      .eq('fleet_id', fleetId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setInvitations(data ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [fleetId]);

  const handleRevoke = async (inv: Invitation) => {
    if (!confirm(`Revoke invite for ${inv.driver_phone}? They will no longer be able to join using this link.`)) return;

    setRevoking(inv.id);
    setRevokeError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token ?? null;
      if (!accessToken) throw new Error('Not authenticated');

      const { error: fnErr } = await supabase.functions.invoke('invite-api', {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: { action: 'revoke', token: inv.invite_token },
      });

      if (fnErr) {
        let msg = fnErr.message ?? 'Failed to revoke invitation';
        try {
          const errBody = await (fnErr as any).context?.json?.();
          msg = errBody?.error ?? msg;
        } catch { /* use fnErr.message */ }
        throw new Error(msg);
      }

      // Remove from local state immediately
      setInvitations(prev => prev.filter(i => i.id !== inv.id));
    } catch (e: unknown) {
      setRevokeError(e instanceof Error ? e.message : 'Failed to revoke invitation');
    } finally {
      setRevoking(null);
    }
  };

  const getTimeRemaining = (expiresAt: string) => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / 3600000);
    const mins  = Math.floor((diff % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  };

  if (loading) return (
    <div className="bg-gray-800 rounded-xl p-4 animate-pulse">
      <div className="h-4 bg-gray-700 rounded w-48 mb-3" />
      <div className="h-12 bg-gray-700 rounded mb-2" />
      <div className="h-12 bg-gray-700 rounded" />
    </div>
  );

  if (invitations.length === 0) return null;

  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="text-yellow-400" size={18} />
          <h3 className="text-white font-semibold">
            Pending Invitations ({invitations.length})
          </h3>
        </div>
        <button
          onClick={load}
          className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {revokeError && (
        <p className="text-sm text-red-400 bg-red-900/20 border border-red-700/40 rounded-lg px-3 py-2 mb-3">
          {revokeError}
        </p>
      )}

      <div className="space-y-3">
        {invitations.map((inv) => {
          const timeRemaining = getTimeRemaining(inv.expires_at);
          const isExpiring    = new Date(inv.expires_at).getTime() - Date.now() < 3_600_000;
          const isRevoking    = revoking === inv.id;

          return (
            <div
              key={inv.id}
              className="flex items-center justify-between bg-gray-700/60 rounded-lg px-4 py-3"
            >
              <div className="min-w-0">
                {/* vehicle name (may be 'TBD' if not specified at creation) */}
                {inv.vehicle_name && inv.vehicle_name !== 'TBD' && (
                  <p className="text-white text-sm font-medium truncate">
                    {inv.vehicle_name}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-0.5">
                  {inv.driver_phone && (
                    <span className="flex items-center gap-1 text-gray-400 text-xs">
                      <Phone size={11} /> {inv.driver_phone}
                    </span>
                  )}
                  {inv.driver_email && (
                    <span className="flex items-center gap-1 text-gray-400 text-xs truncate max-w-[160px]">
                      <Mail size={11} /> {inv.driver_email}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 ml-2 shrink-0">
                {/* Time remaining badge */}
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  isExpiring
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-yellow-500/20 text-yellow-400'
                }`}>
                  {timeRemaining}
                </span>

                {/* Resend QR */}
                <button
                  onClick={() => onResendQR(inv.invite_token, inv.vehicle_name, inv.driver_phone)}
                  className="flex items-center gap-1.5 text-xs bg-teal-500/20 hover:bg-teal-500/40 text-teal-400 px-2.5 py-1.5 rounded-lg transition"
                  title="Resend QR code"
                >
                  <QrCode size={13} />
                  QR
                </button>

                {/* Revoke */}
                <button
                  onClick={() => handleRevoke(inv)}
                  disabled={isRevoking}
                  className="flex items-center gap-1 text-xs bg-red-500/10 hover:bg-red-500/25 text-red-400 px-2.5 py-1.5 rounded-lg transition disabled:opacity-50"
                  title="Revoke invitation"
                >
                  {isRevoking
                    ? <Loader size={12} className="animate-spin" />
                    : <X size={12} />}
                  Revoke
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

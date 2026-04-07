import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Clock, RefreshCw, Phone, Mail, QrCode } from 'lucide-react';

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
  const [loading, setLoading] = useState(true);

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

  const getTimeRemaining = (expiresAt: string) => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
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

      <div className="space-y-3">
        {invitations.map((inv) => {
          const timeRemaining = getTimeRemaining(inv.expires_at);
          const isExpiring = new Date(inv.expires_at).getTime() - Date.now() < 3600000;

          return (
            <div
              key={inv.id}
              className="flex items-center justify-between bg-gray-700/60 rounded-lg px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">
                  {inv.vehicle_name}
                </p>
                <div className="flex items-center gap-3 mt-1">
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

              <div className="flex items-center gap-3 ml-2 shrink-0">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  isExpiring
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-yellow-500/20 text-yellow-400'
                }`}>
                  {timeRemaining}
                </span>
                <button
                  onClick={() => onResendQR(inv.invite_token, inv.vehicle_name, inv.driver_phone)}
                  className="flex items-center gap-1.5 text-xs bg-teal-500/20 hover:bg-teal-500/40 text-teal-400 px-2.5 py-1.5 rounded-lg transition"
                >
                  <QrCode size={13} />
                  Resend QR
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

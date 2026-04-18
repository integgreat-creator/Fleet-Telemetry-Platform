import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';

interface FleetContextType {
  fleetId: string | null;
  fleetName: string | null;
  userId: string | null;
  vehicleIds: string[];   // IDs of all vehicles in this fleet – used for sub-queries
  loading: boolean;
  refresh: () => void;
}

const FleetContext = createContext<FleetContextType>({
  fleetId: null,
  fleetName: null,
  userId: null,
  vehicleIds: [],
  loading: true,
  refresh: () => {},
});

export function FleetProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const [fleetId, setFleetId]     = useState<string | null>(null);
  const [fleetName, setFleetName] = useState<string | null>(null);
  const [vehicleIds, setVehicleIds] = useState<string[]>([]);
  const [loading, setLoading]     = useState(true);
  const [tick, setTick]           = useState(0);

  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    setLoading(true);

    (async () => {
      // 1. Load the fleet this user manages.
      const { data: fleet } = await supabase
        .from('fleets')
        .select('id, name')
        .eq('manager_id', userId)
        .maybeSingle();

      if (cancelled) return;

      if (!fleet) {
        setLoading(false);
        return;
      }

      // 2. Load vehicle IDs via RPC — includes OBD vehicles where
      //    fleet_id may be NULL on the vehicles row (driver-owned).
      //    Fall back to a combined query if RPC is unavailable.
      let ids: string[] = [];
      try {
        const { data: rpcData } = await supabase
          .rpc('get_fleet_vehicles', { p_fleet_id: fleet.id });
        ids = ((rpcData as { id: string }[] | null) ?? []).map((v) => v.id);
      } catch { /* fall through to fallback */ }

      // If RPC returned nothing, fall back to a direct query that covers:
      //   a) vehicles with fleet_id set correctly
      //   b) vehicles the manager created with owner_id = their user_id
      //      (e.g. added manually before fleet_id was backfilled)
      if (ids.length === 0) {
        const { data: fallback } = await supabase
          .from('vehicles')
          .select('id')
          .or(`fleet_id.eq.${fleet.id},owner_id.eq.${userId}`);
        ids = ((fallback as { id: string }[] | null) ?? []).map((v) => v.id);
      }

      // 3. Set all state atomically so child pages receive fleetId AND
      //    vehicleIds in the same render cycle — prevents a flash where
      //    fleetId is set but vehicleIds is still [] (causing pages to
      //    fall back to incorrect fleet_id queries).
      if (!cancelled) {
        setFleetId(fleet.id);
        setFleetName(fleet.name);
        setVehicleIds(ids);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [userId, tick]);

  return (
    <FleetContext.Provider value={{ fleetId, fleetName, userId, vehicleIds, loading, refresh }}>
      {children}
    </FleetContext.Provider>
  );
}

/** Convenience hook — throws if used outside <FleetProvider>. */
export function useFleet(): FleetContextType {
  return useContext(FleetContext);
}

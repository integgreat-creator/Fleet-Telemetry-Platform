import { useState, useEffect } from 'react';
import { Shield, TrendingUp, TrendingDown, AlertTriangle, Award, Users } from 'lucide-react';
import { supabase, type DriverBehavior, type Vehicle } from '../lib/supabase';

interface BehaviorWithVehicle extends DriverBehavior {
  vehicle_name?: string;
  vehicle_make?: string;
  vehicle_model?: string;
}

export default function DriverScoringPage() {
  const [behaviors, setBehaviors] = useState<BehaviorWithVehicle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const { data } = await supabase
        .from('driver_behavior')
        .select('*, vehicles(name, make, model)')
        .order('driver_score', { ascending: false })
        .limit(200);

      if (data) {
        setBehaviors(
          data.map((b: any) => ({
            ...b,
            vehicle_name: b.vehicles?.name,
            vehicle_make: b.vehicles?.make,
            vehicle_model: b.vehicles?.model,
          }))
        );
      }
    } catch (error) {
      console.error('Error loading driver behavior:', error);
    } finally {
      setLoading(false);
    }
  };

  // Deduplicate: latest record per vehicle (already sorted by score desc, so take first per vehicle)
  const latestPerVehicle = behaviors.reduce<BehaviorWithVehicle[]>((acc, b) => {
    if (!acc.find(x => x.vehicle_id === b.vehicle_id)) acc.push(b);
    return acc;
  }, []);

  const leaderboard = [...latestPerVehicle].sort((a, b) => b.driver_score - a.driver_score);

  const fleetAvgScore =
    leaderboard.length > 0
      ? Math.round(leaderboard.reduce((s, b) => s + b.driver_score, 0) / leaderboard.length)
      : 0;
  const bestScore = leaderboard.length > 0 ? leaderboard[0].driver_score : 0;
  const worstScore = leaderboard.length > 0 ? leaderboard[leaderboard.length - 1].driver_score : 0;
  const totalHarshEvents = leaderboard.reduce(
    (s, b) => s + b.harsh_braking_count + b.harsh_acceleration_count,
    0
  );

  const scoreColor = (score: number) => {
    if (score >= 80) return 'text-green-400';
    if (score >= 60) return 'text-yellow-400';
    return 'text-red-400';
  };

  const scoreBarColor = (score: number) => {
    if (score >= 80) return 'bg-green-500';
    if (score >= 60) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const scoreBadgeClasses = (score: number) => {
    if (score >= 80)
      return 'bg-green-500/20 text-green-400 border border-green-500/30';
    if (score >= 60)
      return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
    return 'bg-red-500/20 text-red-400 border border-red-500/30';
  };

  const scoreLabel = (score: number) => {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Needs Improvement';
    return 'Poor';
  };

  const rankBadge = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Driver Scoring</h1>
        <p className="text-gray-400">
          Behavior-based driver performance scores derived from live sensor data
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Fleet Avg Score',
            value: `${fleetAvgScore}`,
            icon: Shield,
            color: fleetAvgScore >= 80 ? 'text-green-500' : fleetAvgScore >= 60 ? 'text-yellow-500' : 'text-red-500',
            bg: fleetAvgScore >= 80 ? 'bg-green-500/20' : fleetAvgScore >= 60 ? 'bg-yellow-500/20' : 'bg-red-500/20',
          },
          {
            label: 'Best Score',
            value: `${bestScore}`,
            icon: Award,
            color: 'text-green-500',
            bg: 'bg-green-500/20',
          },
          {
            label: 'Worst Score',
            value: `${worstScore}`,
            icon: TrendingDown,
            color: 'text-red-500',
            bg: 'bg-red-500/20',
          },
          {
            label: 'Total Harsh Events',
            value: totalHarshEvents,
            icon: AlertTriangle,
            color: 'text-yellow-500',
            bg: 'bg-yellow-500/20',
          },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 rounded-lg p-5 border border-gray-800">
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-sm text-gray-400">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Score legend */}
      <div className="flex flex-wrap gap-4 bg-gray-900 rounded-lg p-4 border border-gray-800">
        <span className="text-sm text-gray-400 font-medium mr-2">Score Legend:</span>
        {[
          { range: '80 – 100', label: 'Excellent', color: 'bg-green-500', text: 'text-green-400' },
          { range: '60 – 79', label: 'Needs Improvement', color: 'bg-yellow-500', text: 'text-yellow-400' },
          { range: '0 – 59', label: 'Poor', color: 'bg-red-500', text: 'text-red-400' },
        ].map(l => (
          <div key={l.label} className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${l.color}`} />
            <span className={`text-xs font-semibold ${l.text}`}>{l.range}</span>
            <span className="text-xs text-gray-500">{l.label}</span>
          </div>
        ))}
      </div>

      {/* Leaderboard table */}
      {leaderboard.length === 0 ? (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
          <Users className="w-16 h-16 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 text-lg">No driver behavior data yet</p>
          <p className="text-gray-600 text-sm mt-2">
            Run the AI intelligence engine with the populate-behavior action to generate scores
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h2 className="text-lg font-bold text-white">Driver Leaderboard</h2>
            <p className="text-sm text-gray-400">Latest trip score per vehicle, ranked highest to lowest</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider w-12">
                    Rank
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Vehicle
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider min-w-[180px]">
                    Score
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Harsh Braking
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Harsh Accel
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Excess RPM
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Excess Speed
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Avg Load
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {leaderboard.map((b, idx) => {
                  const rank = idx + 1;
                  const score = b.driver_score;
                  return (
                    <tr key={b.id} className="hover:bg-gray-800/50 transition-colors">
                      {/* Rank */}
                      <td className="px-4 py-3 text-sm font-bold text-gray-300">
                        {rank <= 3 ? (
                          <span className="text-base">{rankBadge(rank)}</span>
                        ) : (
                          <span className="text-gray-500">{rankBadge(rank)}</span>
                        )}
                      </td>

                      {/* Vehicle */}
                      <td className="px-4 py-3">
                        <p className="text-white font-medium text-sm">
                          {b.vehicle_name || 'Unknown'}
                        </p>
                        {(b.vehicle_make || b.vehicle_model) && (
                          <p className="text-gray-500 text-xs">
                            {b.vehicle_make} {b.vehicle_model}
                          </p>
                        )}
                      </td>

                      {/* Score with bar */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            className={`inline-flex items-center px-2.5 py-1 rounded-lg text-sm font-bold min-w-[52px] justify-center ${scoreBadgeClasses(score)}`}
                          >
                            {score}
                          </span>
                          <div className="flex-1 min-w-[80px]">
                            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${scoreBarColor(score)}`}
                                style={{ width: `${score}%` }}
                              />
                            </div>
                            <p className={`text-xs mt-0.5 ${scoreColor(score)}`}>
                              {scoreLabel(score)}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* Event counts */}
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-medium ${b.harsh_braking_count > 5 ? 'text-red-400' : 'text-gray-300'}`}>
                          {b.harsh_braking_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-medium ${b.harsh_acceleration_count > 5 ? 'text-red-400' : 'text-gray-300'}`}>
                          {b.harsh_acceleration_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-medium ${b.excessive_rpm_count > 10 ? 'text-yellow-400' : 'text-gray-300'}`}>
                          {b.excessive_rpm_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-medium ${b.excessive_speed_count > 3 ? 'text-red-400' : 'text-gray-300'}`}>
                          {b.excessive_speed_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-medium ${b.average_engine_load > 60 ? 'text-yellow-400' : 'text-gray-300'}`}>
                          {b.average_engine_load.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Scoring methodology note */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-5">
        <div className="flex items-start gap-3">
          <TrendingUp className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">How scores are calculated</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Driver score starts at 100 and is penalized as follows: each harsh braking event −2 pts,
              each harsh acceleration event −2 pts, each excessive speed reading (over 120 km/h) −3 pts,
              and average engine load above baseline −0.1 pts per unit. Scores are capped between 0 and 100.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

import { Lock, ArrowRight, Sparkles, Zap, TrendingUp } from 'lucide-react';
import {
  useSubscription,
  FEATURE_MIN_PLAN,
  FEATURE_DISPLAY,
  PLAN_DISPLAY_NAME,
  type PlanName,
} from '../hooks/useSubscription';

interface Props {
  feature:      string;
  // Override copy if needed
  title?:       string;
  description?: string;
  onNavigateToAdmin?: () => void;
}

type PlanStyle = { icon: typeof Sparkles; accent: string; badge: string };

// Icon and colour per required plan. Only active plans are styled here — legacy
// starter/growth/pro are intentionally omitted and fall back to `essential`.
const PLAN_STYLE: Partial<Record<PlanName, PlanStyle>> = {
  trial:        { icon: Sparkles,   accent: 'text-gray-400',   badge: 'bg-gray-700 text-gray-300'   },
  essential:    { icon: Sparkles,   accent: 'text-blue-400',   badge: 'bg-blue-900/60 text-blue-300'   },
  professional: { icon: TrendingUp, accent: 'text-teal-400',   badge: 'bg-teal-900/60 text-teal-300'   },
  business:     { icon: Zap,        accent: 'text-purple-400', badge: 'bg-purple-900/60 text-purple-300' },
  enterprise:   { icon: Sparkles,   accent: 'text-yellow-400', badge: 'bg-yellow-900/60 text-yellow-300' },
};

const DEFAULT_STYLE: PlanStyle = PLAN_STYLE.essential!;

export default function UpgradePrompt({ feature, title, description, onNavigateToAdmin }: Props) {
  const { plan, planDisplayName } = useSubscription();

  const requiredPlan  = FEATURE_MIN_PLAN[feature] ?? 'essential';
  const featureLabel  = FEATURE_DISPLAY[feature]  ?? feature;
  const requiredLabel = PLAN_DISPLAY_NAME[requiredPlan] ?? requiredPlan;
  const style         = PLAN_STYLE[requiredPlan] ?? DEFAULT_STYLE;
  const PlanIcon      = style.icon;

  const promptTitle = title ?? `${featureLabel} is not available on your plan`;
  const promptDesc  = description ??
    `You're currently on the ${planDisplayName || (plan ?? 'Trial')} plan. ` +
    `Upgrade to ${requiredLabel} or above to unlock this feature.`;

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      {/* Lock icon with plan-coloured ring */}
      <div className={`relative mb-6`}>
        <div className="w-20 h-20 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center">
          <Lock className="w-9 h-9 text-gray-400" />
        </div>
        {/* Plan badge overlay */}
        <div className={`absolute -bottom-2 -right-2 p-1.5 rounded-lg ${style.badge}`}>
          <PlanIcon className={`w-3.5 h-3.5 ${style.accent}`} />
        </div>
      </div>

      {/* Required plan badge */}
      <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold mb-4 ${style.badge}`}>
        <PlanIcon className={`w-3 h-3 ${style.accent}`} />
        Requires {requiredLabel} plan
      </span>

      <h2 className="text-xl font-bold text-white mb-2 max-w-sm">{promptTitle}</h2>
      <p className="text-gray-400 text-sm max-w-md leading-relaxed mb-8">{promptDesc}</p>

      {/* What you get card */}
      <FeatureBenefitCard feature={feature} requiredPlan={requiredPlan} />

      {/* CTA */}
      {onNavigateToAdmin && (
        <button
          onClick={onNavigateToAdmin}
          className="mt-6 flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors shadow-lg shadow-blue-500/20"
        >
          Upgrade Plan
          <ArrowRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ─── Small "what you unlock" card ─────────────────────────────────────────────

const FEATURE_BENEFITS: Record<string, string[]> = {
  driver_behavior:      ['Harsh braking / acceleration detection', 'Driver score per trip', 'Individual driver comparison'],
  maintenance_alerts:   ['Predictive maintenance alerts', 'Component health tracking', 'Scheduled service reminders'],
  cost_analytics:       ['Monthly cost forecasts', 'Fuel vs maintenance breakdown', 'Cost optimisation insights'],
  ai_prediction:        ['AI-powered anomaly detection', 'GPS tamper alerts', 'Fuel theft detection'],
  fuel_monitoring:      ['Fuel consumption trends', 'Refuel event tracking', 'Fuel efficiency per vehicle'],
  fuel_theft_detection: ['Real-time theft alerts', 'Unexpected drain events', 'Driver accountability reports'],
  multi_user:           ['Invite team members', 'Role-based access', 'Shared fleet visibility'],
  api_access:           ['REST API access', 'Webhook notifications', 'Third-party integrations'],
  custom_reports:       ['Scheduled reports', 'Exportable CSV/PDF', 'Custom date ranges'],
};

function FeatureBenefitCard({ feature, requiredPlan }: { feature: string; requiredPlan: PlanName }) {
  const benefits = FEATURE_BENEFITS[feature];
  if (!benefits) return null;

  const style = PLAN_STYLE[requiredPlan] ?? DEFAULT_STYLE;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 w-full max-w-sm text-left">
      <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-3">
        What you unlock
      </p>
      <ul className="space-y-2">
        {benefits.map(b => (
          <li key={b} className="flex items-center gap-2 text-sm text-gray-300">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 bg-current ${style.accent}`} />
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useSubscription } from '../hooks/useSubscription';
import UpgradePrompt from './UpgradePrompt';

interface Props {
  /** Feature key — must match a key in FEATURE_MIN_PLAN */
  feature: string;
  children: ReactNode;

  /**
   * How to render when access is denied:
   *  'prompt' (default) — full-page UpgradePrompt overlay
   *  'blur'             — blurred content with a centred lock icon
   *  'hide'             — renders nothing at all
   */
  fallback?: 'prompt' | 'blur' | 'hide';

  /** Forwarded to UpgradePrompt when fallback='prompt' */
  onNavigateToAdmin?: () => void;
}

export default function FeatureGate({
  feature,
  children,
  fallback = 'prompt',
  onNavigateToAdmin,
}: Props) {
  const { feature: checkFeature, loading } = useSubscription();

  // While the subscription state is still loading, render children as-is.
  // (The hook defaults feature() → 'full' during loading to prevent flashing.)
  if (loading) return <>{children}</>;

  const level = checkFeature(feature);

  // Full access → render normally
  if (level === 'full' || level === 'limited') return <>{children}</>;

  // Denied ─────────────────────────────────────────────────────────────────────

  if (fallback === 'hide') return null;

  if (fallback === 'blur') {
    return (
      <div className="relative">
        {/* Blur the underlying content */}
        <div className="pointer-events-none select-none blur-sm opacity-40">
          {children}
        </div>

        {/* Centred lock badge */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center shadow-xl">
            <Lock className="w-6 h-6 text-gray-400" />
          </div>
          <p className="text-sm text-gray-400 font-medium">
            Upgrade your plan to unlock this feature
          </p>
          {onNavigateToAdmin && (
            <button
              onClick={onNavigateToAdmin}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors"
            >
              View Plans
            </button>
          )}
        </div>
      </div>
    );
  }

  // fallback === 'prompt' (default)
  return (
    <UpgradePrompt
      feature={feature}
      onNavigateToAdmin={onNavigateToAdmin}
    />
  );
}

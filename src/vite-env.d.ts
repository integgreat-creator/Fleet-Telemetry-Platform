/// <reference types="vite/client" />

// ─── import.meta.env typing ──────────────────────────────────────────────────

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL:      string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /// Razorpay public key id. When unset the upgrade flow falls back to a
  /// "online payments not yet enabled" message — see PlanCheckoutModal.
  readonly VITE_RAZORPAY_KEY_ID?:  string;
  /// WhatsApp number for enterprise sales inquiries. Country code + number,
  /// digits only (e.g. "919876543210"). When unset the Enterprise plan
  /// "Contact Sales" CTA falls back to an email alert. See AdminPage
  /// handleEnterpriseContact (Phase 1.2.5).
  readonly VITE_SALES_WHATSAPP_NUMBER?: string;
  /// Comma-separated list of operator email addresses. When the logged-in
  /// user's email matches, the "Insights" link is shown in the sidebar.
  /// Phase 2.1.
  readonly VITE_OPERATOR_EMAILS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// ─── Razorpay embedded Checkout ──────────────────────────────────────────────
// Loaded as a <script> tag in index.html. The constructor is called by
// AdminPage once a Razorpay subscription has been created server-side.
// Only the fields we actually use are typed; the SDK accepts many more.

interface RazorpayCheckoutOptions {
  key:                string;
  subscription_id?:   string;
  order_id?:          string;
  amount?:            number;       // paise — display only when subscription_id is set
  currency?:          string;       // 'INR'
  name?:              string;       // merchant name shown in the modal
  description?:       string;
  image?:             string;
  prefill?: {
    name?:  string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: { color?: string };
  modal?: {
    ondismiss?: () => void;
    escape?:    boolean;
    backdropclose?: boolean;
  };
  handler?: (response: {
    razorpay_payment_id?:      string;
    razorpay_subscription_id?: string;
    razorpay_signature?:       string;
  }) => void;
}

interface RazorpayInstance {
  open():  void;
  close(): void;
  on(event: 'payment.failed', cb: (response: unknown) => void): void;
}

interface Window {
  Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayInstance;
}


import { useState, useEffect } from 'react';
import { Key, Plus, Copy, Check, Trash2, Loader, Globe, Link2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface WebhookConfig {
  webhook_url: string | null;
}

interface Props {
  fleetId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const abs  = Math.abs(diff);
    const past = diff >= 0;
    const fmt  = (n: number, unit: string) =>
      past ? `${n} ${unit}${n !== 1 ? 's' : ''} ago` : `in ${n} ${unit}${n !== 1 ? 's' : ''}`;
    if (abs < 60_000)         return fmt(Math.round(abs / 1_000),         'second');
    if (abs < 3_600_000)      return fmt(Math.round(abs / 60_000),         'minute');
    if (abs < 86_400_000)     return fmt(Math.round(abs / 3_600_000),      'hour');
    if (abs < 2_592_000_000)  return fmt(Math.round(abs / 86_400_000),     'day');
    if (abs < 31_536_000_000) return fmt(Math.round(abs / 2_592_000_000),  'month');
    return fmt(Math.round(abs / 31_536_000_000), 'year');
  } catch {
    return ts;
  }
}

function generateRawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex   = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `vs_${hex}`;
}

async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ApiAccessTab({ fleetId }: Props) {
  const [keys, setKeys]                     = useState<ApiKey[]>([]);
  const [webhookUrl, setWebhookUrl]         = useState('');
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState<string | null>(null);

  const [creating, setCreating]             = useState(false);
  const [newKeyName, setNewKeyName]         = useState('');
  const [newKeyGenerating, setNewKeyGenerating] = useState(false);

  const [generatedKey, setGeneratedKey]     = useState<string | null>(null);
  const [copiedKey, setCopiedKey]           = useState(false);

  const [revokingId, setRevokingId]         = useState<string | null>(null);

  const [webhookSaving, setWebhookSaving]   = useState(false);
  const [webhookSaved, setWebhookSaved]     = useState(false);

  const baseUrl = import.meta.env.VITE_SUPABASE_URL
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
    : 'https://<your-project>.supabase.co/functions/v1';

  // ─── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!fleetId) return;
    loadData();
  }, [fleetId]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [keysRes, whRes] = await Promise.all([
        supabase
          .from('api_keys')
          .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
          .eq('fleet_id', fleetId)
          .is('revoked_at', null)
          .order('created_at', { ascending: false }),
        supabase
          .from('webhook_config')
          .select('webhook_url')
          .eq('fleet_id', fleetId)
          .single(),
      ]);
      if (keysRes.error) throw keysRes.error;
      setKeys(keysRes.data ?? []);
      const wh = whRes.data as WebhookConfig | null;
      if (wh?.webhook_url) setWebhookUrl(wh.webhook_url);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load API access data');
    } finally {
      setLoading(false);
    }
  };

  // ─── Create key ────────────────────────────────────────────────────────────

  const createKey = async () => {
    if (!newKeyName.trim()) return;
    setNewKeyGenerating(true);
    try {
      const raw    = generateRawKey();
      const hash   = await hashKey(raw);
      const prefix = raw.slice(0, 10);

      const { data: { user } } = await supabase.auth.getUser();

      const { error: insertError } = await supabase.from('api_keys').insert({
        fleet_id:   fleetId,
        name:       newKeyName.trim(),
        key_hash:   hash,
        key_prefix: prefix,
        created_by: user?.id ?? null,
      });
      if (insertError) throw insertError;

      setGeneratedKey(raw);
      setCreating(false);
      setNewKeyName('');
      await loadData();
    } catch (e: any) {
      setError(e.message ?? 'Failed to create API key');
    } finally {
      setNewKeyGenerating(false);
    }
  };

  // ─── Copy key ──────────────────────────────────────────────────────────────

  const copyKey = async () => {
    if (!generatedKey) return;
    try {
      await navigator.clipboard.writeText(generatedKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2500);
    } catch {
      // silently fail — user can manually select
    }
  };

  // ─── Revoke key ────────────────────────────────────────────────────────────

  const revoke = async (key: ApiKey) => {
    if (!confirm(`Revoke key "${key.name}"? Any app using this key will lose access immediately.`)) return;
    setRevokingId(key.id);
    try {
      const { error: updateError } = await supabase
        .from('api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', key.id);
      if (updateError) throw updateError;
      setKeys(prev => prev.filter(k => k.id !== key.id));
    } catch (e: any) {
      setError(e.message ?? 'Failed to revoke key');
    } finally {
      setRevokingId(null);
    }
  };

  // ─── Save webhook ──────────────────────────────────────────────────────────

  const saveWebhook = async () => {
    setWebhookSaving(true);
    try {
      const { error: upsertError } = await supabase
        .from('webhook_config')
        .upsert(
          {
            fleet_id:    fleetId,
            webhook_url: webhookUrl.trim(),
            updated_at:  new Date().toISOString(),
          },
          { onConflict: 'fleet_id' }
        );
      if (upsertError) throw upsertError;
      setWebhookSaved(true);
      setTimeout(() => setWebhookSaved(false), 3000);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save webhook');
    } finally {
      setWebhookSaving(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader className="w-5 h-5 animate-spin mr-2" />
        Loading API access settings…
      </div>
    );
  }

  return (
    <div className="space-y-8">

      {/* Error */}
      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* ── Base URL info box ────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-white font-medium">
          <Globe className="w-4 h-4 text-blue-400" />
          API Base URL
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-32 shrink-0">Base URL</span>
            <code className="text-blue-300 font-mono break-all">{baseUrl}</code>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-32 shrink-0">Authentication</span>
            <code className="text-gray-300 font-mono">
              Authorization: Bearer &lt;your-api-key&gt;
            </code>
          </div>
        </div>
      </div>

      {/* ── API Keys section ─────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold text-base flex items-center gap-2">
            <Key className="w-4 h-4 text-blue-400" />
            API Keys
          </h3>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create New Key
            </button>
          )}
        </div>

        {/* Generated key banner */}
        {generatedKey && (
          <div className="bg-yellow-900/30 border border-yellow-600 rounded-xl p-4 space-y-3">
            <p className="text-yellow-300 text-sm font-medium">
              ⚠ Copy your API key now — it will never be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-gray-950 text-green-300 font-mono text-sm px-3 py-2 rounded-lg break-all border border-gray-700">
                {generatedKey}
              </code>
              <button
                onClick={copyKey}
                className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
              >
                {copiedKey ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                {copiedKey ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              onClick={() => setGeneratedKey(null)}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Done — I've saved my key
            </button>
          </div>
        )}

        {/* Create form */}
        {creating && (
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
            <p className="text-sm text-gray-300 font-medium">New API Key</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createKey(); if (e.key === 'Escape') { setCreating(false); setNewKeyName(''); } }}
                placeholder="e.g. Production App"
                className="flex-1 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={createKey}
                disabled={newKeyGenerating || !newKeyName.trim()}
                className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                {newKeyGenerating
                  ? <><Loader className="w-4 h-4 animate-spin" /> Generating…</>
                  : <><Key className="w-4 h-4" /> Generate Key</>}
              </button>
              <button
                onClick={() => { setCreating(false); setNewKeyName(''); }}
                className="px-3 py-2 text-gray-400 hover:text-white text-sm rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Keys table */}
        {keys.length === 0 && !creating ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-10 text-center">
            <Key className="w-8 h-8 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400 text-sm">
              No API keys yet. Create one to access the API programmatically.
            </p>
          </div>
        ) : keys.length > 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-400 font-medium px-4 py-3">Name</th>
                  <th className="text-left text-gray-400 font-medium px-4 py-3">Key</th>
                  <th className="text-left text-gray-400 font-medium px-4 py-3 whitespace-nowrap">Created</th>
                  <th className="text-left text-gray-400 font-medium px-4 py-3 whitespace-nowrap">Last Used</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {keys.map(key => (
                  <tr key={key.id} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{key.name}</td>
                    <td className="px-4 py-3">
                      <code className="text-gray-300 font-mono text-xs bg-gray-800 px-2 py-1 rounded">
                        {key.key_prefix}…
                      </code>
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                      {relativeTime(key.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                      {key.last_used_at ? relativeTime(key.last_used_at) : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => revoke(key)}
                        disabled={revokingId === key.id}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed text-xs rounded-lg transition-colors ml-auto"
                      >
                        {revokingId === key.id
                          ? <Loader className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />}
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ── Webhook Configuration section ────────────────────────────────── */}
      <div className="space-y-4">
        <h3 className="text-white font-semibold text-base flex items-center gap-2">
          <Link2 className="w-4 h-4 text-blue-400" />
          Webhook Configuration
        </h3>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-gray-300 font-medium">Webhook URL</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
              placeholder="https://your-server.com/webhook"
              className="w-full bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-gray-500">
              FTPGo will POST subscription and alert events to this URL.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={saveWebhook}
              disabled={webhookSaving}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              {webhookSaving ? (
                <><Loader className="w-4 h-4 animate-spin" /> Saving…</>
              ) : (
                'Save Webhook'
              )}
            </button>
            {webhookSaved && (
              <span className="flex items-center gap-1 text-green-400 text-sm">
                <Check className="w-4 h-4" />
                Saved
              </span>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

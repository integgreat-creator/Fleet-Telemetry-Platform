import { useState } from 'react';
import { Car } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fleetName, setFleetName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      } else {
        if (!fleetName.trim()) {
          throw new Error('Fleet Name is required for sign up');
        }

        // Use the fleet-signup edge function which uses the service role to:
        // 1. Create the auth user (email pre-confirmed)
        // 2. Create the fleet record atomically
        // 3. Sign in and return a session
        let res: Response;
        try {
          res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fleet-signup`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                email:      email.trim().toLowerCase(),
                password,
                fleet_name: fleetName.trim(),
              }),
            }
          );
        } catch {
          throw new Error('Cannot reach the server. Please check your internet connection.');
        }

        let body: any;
        try {
          body = await res.json();
        } catch {
          throw new Error(`Server error (HTTP ${res.status}). The fleet-signup function may not be deployed yet.`);
        }

        if (!res.ok) {
          throw new Error(body?.error || `Sign up failed (HTTP ${res.status})`);
        }

        if (!body?.session) {
          throw new Error('Sign up succeeded but no session was returned. Please try logging in.');
        }

        const { error: sessionError } = await supabase.auth.setSession(body.session);
        if (sessionError) throw sessionError;
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center space-x-3 mb-4">
            <Car className="w-12 h-12 text-blue-500" />
            <h1 className="text-4xl font-bold text-white">Fleet Telemetry</h1>
          </div>
          <p className="text-gray-400">Vehicle monitoring and fleet management platform</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-8 border border-gray-800">
          <div className="flex space-x-2 mb-6">
            <button
              onClick={() => setIsLogin(true)}
              className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                isLogin
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              Login
            </button>
            <button
              onClick={() => setIsLogin(false)}
              className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                !isLogin
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              Sign Up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Fleet Name</label>
                <input
                  type="text"
                  required
                  value={fleetName}
                  onChange={(e) => setFleetName(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                  placeholder="Your Fleet Name"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                placeholder="••••••••"
                minLength={6}
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/50 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
            >
              {loading ? 'Loading...' : isLogin ? 'Login' : 'Sign Up'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-gray-800">
            <p className="text-xs text-gray-500 text-center">
              {isLogin ? "Don't have an account? " : 'Already have an account? '}
              <button
                onClick={() => setIsLogin(!isLogin)}
                className="text-blue-500 hover:text-blue-400"
              >
                {isLogin ? 'Sign up' : 'Login'}
              </button>
            </p>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-gray-500">
          <p>Demo credentials available for testing</p>
        </div>
      </div>
    </div>
  );
}

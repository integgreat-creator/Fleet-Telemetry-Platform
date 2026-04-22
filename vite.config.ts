import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  build: {
    // Warn when any individual chunk exceeds 600 KB (default 500 KB is too noisy
    // with map/chart libraries; anything over 600 KB genuinely needs attention).
    chunkSizeWarningLimit: 600,

    rollupOptions: {
      output: {
        manualChunks: {
          // Core React runtime — cached aggressively; almost never changes
          'vendor-react':    ['react', 'react-dom'],
          // Supabase client — large but stable; separate cache entry
          'vendor-supabase': ['@supabase/supabase-js'],
          // Map stack — only loaded when user navigates to Map/Geofences
          'vendor-map':      ['leaflet', 'react-leaflet'],
          // Icon library — tree-shaken but still sizeable; isolate for caching
          'vendor-icons':    ['lucide-react'],
          // QR code — only needed on driver-invite flows
          'vendor-qr':       ['qrcode.react'],
        },
      },
    },
  },
});

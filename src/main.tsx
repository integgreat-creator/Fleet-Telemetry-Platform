import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// leaflet/dist/leaflet.css is imported inside FleetMapPage and GeofencesPage
// (the only two pages that use Leaflet) so it is bundled with those lazy chunks
// instead of blocking the critical CSS path on every page load.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

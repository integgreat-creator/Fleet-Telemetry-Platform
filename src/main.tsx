import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// Side-effecting import: bootstraps i18next before any component reads
// `useTranslation`. Must precede the App import below so resources are
// registered when the first render runs. Phase 1.5.1.
import './i18n';
// leaflet/dist/leaflet.css is imported inside FleetMapPage and GeofencesPage
// (the only two pages that use Leaflet) so it is bundled with those lazy chunks
// instead of blocking the critical CSS path on every page load.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

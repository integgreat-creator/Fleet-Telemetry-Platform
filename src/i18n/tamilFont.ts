/**
 * Lazy loader for Noto Sans Tamil (Phase 1.5.1, D16).
 *
 * Why this exists: most desktop and mobile OSes ship a Tamil-capable system
 * font, so an English-only user would never need this asset. But Tamil glyph
 * coverage is patchy on stock Linux / Chromebook installs — without a
 * fallback, customers see boxes (▢▢▢) instead of script. We fix that by
 * injecting a Google Fonts <link> the first time Tamil is requested, and
 * never for English-only sessions.
 *
 * Idempotent — multiple `ensureTamilFontLoaded()` calls only inject the
 * <link> once.
 */

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;600;700&display=swap';

let injected = false;

export function ensureTamilFontLoaded(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;       // SSR / tests — no-op

  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = FONT_HREF;
  // Marker for debuggability — easy to grep in DevTools to confirm the
  // font landed only once.
  link.dataset.i18n = 'noto-sans-tamil';
  document.head.appendChild(link);

  injected = true;
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────
// Tiny self-contained serializer + browser download. Used by InsightsPage
// to let operators export the dashboard tables. Kept local instead of
// pulling in a CSV lib because everything we need fits in <40 lines —
// papaparse / fast-csv add ~20 KB for capabilities (parsing, streaming) we
// don't use on a write-only path.

/// RFC-4180 escape: quote any field containing comma, quote, CR, or LF;
/// double-up internal quotes. Numbers / null get coerced to a clean string.
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/// Build a CSV string from row objects. `columns` controls both order and
/// the header row; if omitted, the keys of the first row are used.
export function toCsv(
  rows:    ReadonlyArray<Record<string, unknown>>,
  columns?: ReadonlyArray<string>,
): string {
  if (rows.length === 0) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const lines: string[] = [
    cols.map(escapeCsvField).join(','),
    ...rows.map(row => cols.map(c => escapeCsvField(row[c])).join(',')),
  ];
  // Excel & Numbers both accept \r\n line endings on import; \n alone
  // sometimes confuses Excel-on-Windows date-column heuristics.
  return lines.join('\r\n');
}

/// Trigger a browser download of the given CSV. The leading ﻿ BOM is
/// what makes Excel-on-Windows correctly detect UTF-8 — without it, ₹ and
/// other non-ASCII glyphs render as mojibake (ÃƒÂ¢Ã¢â‚¬"Â¹).
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;        // SSR / tests — no-op
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // The DOM cleanup + URL revoke after the click are tiny but matter:
  // long-lived object URLs leak the blob memory until the tab closes.
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/// "YYYY-MM-DD" suffix derived from an ISO timestamp (`generated_at` in our
/// case). Lets exported filenames sort sensibly when an operator downloads
/// multiple over a few days. Falls back to today if the input is unparsable.
export function dateStampForCsv(iso: string | undefined): string {
  if (!iso) return new Date().toISOString().slice(0, 10);
  const d = new Date(iso);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function timeAgo(isoOrDate: string | Date | undefined | null): string {
  if (!isoOrDate) return '';
  const t = typeof isoOrDate === 'string' ? new Date(isoOrDate).getTime() : isoOrDate.getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatRs(n: number | null | undefined): string {
  if (n == null) return '—';
  try { return `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
  catch { return `₹${n}`; }
}

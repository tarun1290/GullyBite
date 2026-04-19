import { useCallback, useEffect, useState } from 'react';

// Shared fetch-with-cancel hook for analytics sections. Re-runs whenever any
// value in `deps` changes, swallows races via a cancelled flag, and exposes
// a `refetch()` so the section's Retry button can re-run the same call
// without remounting.
export default function useAnalyticsFetch(fetchFn, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFn()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.error || e?.message || 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, refetch };
}

import { useEffect, useState } from 'react';

const PREFIX = '#series=';

function readRoute(): string | null {
  if (!window.location.hash.startsWith(PREFIX)) return null;
  const id = decodeURIComponent(window.location.hash.slice(PREFIX.length));
  return id || null;
}

/**
 * Which Series the Library shows, kept in the URL hash so browser back and
 * forward move between the grid and a Series, and a reload stays put.
 */
export function useSeriesRoute() {
  const [seriesId, setSeriesId] = useState(readRoute);

  useEffect(() => {
    const sync = () => setSeriesId(readRoute());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  function go(next: string | null, mode: 'push' | 'replace' = 'push') {
    const url = `${window.location.pathname}${window.location.search}${next ? `${PREFIX}${encodeURIComponent(next)}` : ''}`;
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    setSeriesId(next);
  }

  return {
    seriesId,
    openSeries: (id: string) => go(id),
    closeSeries: () => go(null),
    /** Leaves a Series that no longer exists without adding a history entry for it. */
    dropSeries: () => go(null, 'replace'),
  };
}

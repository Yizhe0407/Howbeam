import { useEffect, useRef, useState } from 'react';

/** How long work must run before it is worth telling the person about. */
export const BUSY_DELAY_MS = 300;
/** Once shown, how long a busy state stays, so it never blinks. */
export const BUSY_MIN_SHOWN_MS = 500;

/**
 * Whether to show that work is in progress. Work that finishes within
 * `BUSY_DELAY_MS` never shows anything, and work that does show stays up for
 * at least `BUSY_MIN_SHOWN_MS`. Every busy affordance (spinner, dimmed
 * controls, progress notice) reads this instead of the raw flag, so a click
 * that takes a few milliseconds changes nothing on screen. The raw flag is
 * still what guards against a second operation.
 */
export function useDeferredBusy(active: boolean): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (active === shown) return undefined;
    const wait = active ? BUSY_DELAY_MS : Math.max(0, BUSY_MIN_SHOWN_MS - (Date.now() - shownAt.current));
    const timer = setTimeout(() => {
      if (active) shownAt.current = Date.now();
      setShown(active);
    }, wait);
    return () => clearTimeout(timer);
  }, [active, shown]);

  return shown;
}

import { useEffect, useRef, type UIEventHandler } from 'react';

const SCROLLBAR_IDLE_MS = 800;

/**
 * Marks the element with `data-scrolling` while it scrolls so
 * `.app-scrollbar-autohide` paints its thumb only then. The attribute is set
 * on the DOM directly: toggling it must not re-render the scrolled list.
 */
export function useAutoHideScrollbar<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onScroll: UIEventHandler<T> = () => {
    const element = ref.current;
    if (!element) return;
    element.dataset.scrolling = '';
    clearTimeout(timer.current);
    timer.current = setTimeout(() => delete element.dataset.scrolling, SCROLLBAR_IDLE_MS);
  };

  return { ref, onScroll };
}

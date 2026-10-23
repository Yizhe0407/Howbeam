import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@/lib/shared/i18n';

/** Mounts `children` (a screenshot preview) only once it nears the viewport, so long lists don't decode every image up front. */
export default function LazyPreview({ eager, children }: { eager: boolean; children: ReactNode }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(eager);

  useEffect(() => {
    if (eager || visible) {
      setVisible(true);
      return;
    }
    const element = host.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '320px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, visible]);

  return (
    <div
      ref={host}
      aria-busy={!visible}
      className="relative size-full overflow-hidden"
    >
      {visible ? children : <span className="sr-only">{t().common.thumbnailPending}</span>}
    </div>
  );
}

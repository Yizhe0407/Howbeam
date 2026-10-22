import type { CSSProperties } from 'react';
import { Toaster } from 'react-hot-toast';

/**
 * How every notice looks. The stock toasts get it through `toastOptions`, and a
 * custom notice (one with its own buttons) spreads the same object, so the
 * three kinds of notice can't drift apart.
 */
export const noticeStyle: CSSProperties = {
  maxWidth: '440px',
  padding: '10px 14px',
  borderRadius: 'var(--radius)',
  border: '2px solid var(--border)',
  background: 'var(--card)',
  color: 'var(--foreground)',
  boxShadow: 'none',
  fontSize: '13px',
  fontWeight: 700,
  lineHeight: '1.5',
};

/**
 * The one place notices appear: transient feedback, work in progress and
 * undo offers all stack here, bottom-right. A page lines the stack up with its
 * own content through two custom properties: `--content-gutter`, the gutter its
 * content uses, and `--bottom-bar-height`, the height of anything fixed along
 * the bottom edge. Errors stay as persistent in-page alerts instead. Colours use
 * theme tokens so notices follow OS dark mode.
 */
export default function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      gutter={10}
      containerStyle={{
        zIndex: 60,
        right: 'var(--content-gutter, 1rem)',
        bottom: 'calc(var(--bottom-bar-height, 0px) + 1rem)',
      }}
      toastOptions={{
        duration: 4_000,
        style: noticeStyle,
        success: { iconTheme: { primary: 'var(--brand-text)', secondary: 'var(--card)' } },
        error: { iconTheme: { primary: 'var(--destructive)', secondary: 'var(--card)' } },
      }}
    />
  );
}

import { useEffect } from 'react';
import { browser } from 'wxt/browser';

/**
 * Announces which extension page this tab shows, so every later "open the
 * editor / open the library" request reuses it instead of spawning another
 * tab. lib/recording/background/extension-page-tabs.ts explains why the
 * background cannot discover its own pages without this. Every page
 * registers: pages navigate their tab between one another, and each
 * registration replaces whatever the tab was remembered as before.
 *
 * Re-announced whenever the window regains focus — if several copies of a
 * page are open, the one the user last looked at is the one that gets
 * reused — and when the page is restored from the back/forward cache, which
 * re-shows it without mounting it again.
 */
export function useExtensionPageRegistration(): void {
  useEffect(() => {
    const register = () => {
      void (async () => {
        try {
          await browser.runtime.sendMessage({ type: 'REGISTER_EXTENSION_PAGE' });
        } catch (error) {
          // Non-fatal: the page still works, later opens just cannot reuse it.
          console.warn('[howbeam] failed to register this extension page tab', error);
        }
      })();
    };
    const registerIfRestored = (event: PageTransitionEvent) => {
      if (event.persisted) register();
    };
    register();
    window.addEventListener('focus', register);
    window.addEventListener('pageshow', registerIfRestored);
    return () => {
      window.removeEventListener('focus', register);
      window.removeEventListener('pageshow', registerIfRestored);
    };
  }, []);
}

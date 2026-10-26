import { getOpenOrClosedShadowRoot } from './shadow-dom';
import { isExtensionOverlay } from './viewport-overlay-host';

/** document.getAnimations() leaves out shadow trees, so each page shadow root
 * is asked separately. The recorder's own overlays are skipped. */
function collectPageShadowRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const visit = (scope: Document | ShadowRoot) => {
    for (const element of scope.querySelectorAll('*')) {
      if (isExtensionOverlay(element)) continue;
      const root = getOpenOrClosedShadowRoot(element);
      if (!root) continue;
      roots.push(root);
      visit(root);
    }
  };
  visit(document);
  return roots;
}

/**
 * Holds the page's CSS animations, CSS transitions and Web Animations still,
 * including ones that start while held, so a screenshot and the boxes read
 * from the DOM afterwards describe the same moment. Returns the release.
 */
export function pauseMotion(): () => void {
  const rates = new Map<Animation, number>();
  const scopes: Array<Document | ShadowRoot> = [document, ...collectPageShadowRoots()];
  const hold = () => {
    for (const scope of scopes) {
      for (const animation of scope.getAnimations()) {
        if (rates.has(animation) || animation.playbackRate === 0) continue;
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (target && isExtensionOverlay(target)) continue;
        // pause() would make the page's own animation-play-state stop working
        // on this animation for good; a zero rate leaves it in control.
        rates.set(animation, animation.playbackRate);
        animation.playbackRate = 0;
      }
    }
  };
  hold();
  let frame = requestAnimationFrame(function tick() {
    hold();
    frame = requestAnimationFrame(tick);
  });
  return () => {
    cancelAnimationFrame(frame);
    for (const [animation, rate] of rates) {
      if (animation.playbackRate === 0) animation.playbackRate = rate;
    }
    rates.clear();
  };
}

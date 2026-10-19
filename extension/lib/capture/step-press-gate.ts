import { replayElementClick, replayElementDoubleClick } from './element-description';
import type { LateClickSuppressor } from './step-capture';
import { isExtensionOverlay } from './viewport-overlay-host';

/**
 * Decides, per trusted press, whether a step-mode gesture is a click (record a
 * step, replay the activation after the screenshot) or something else — a
 * drag, a text selection, a slider move, a double click's second press — that
 * must reach the page natively and never become a step.
 *
 * The press is never `preventDefault()`ed. The page's own listeners are kept
 * from seeing it (`stopImmediatePropagation()` in the capture phase), so a
 * mousedown-driven menu cannot open before the screenshot, while the
 * browser's default actions run untouched: the caret lands where the user
 * clicked, a text selection or native drag can start, a range thumb grabs.
 *
 * - Released without travelling → `click`. The trusted `click` event is
 *   cancelled (its activation — navigation, toggling, submission — is what
 *   must wait for the screenshot) and replayed by the recorder afterwards.
 * - A press on a dropdown `<select>` → `click` at once: its native popup
 *   takes the release, which the page never sees.
 * - Travelled past the drag threshold, or the browser started a native drag
 *   → `drag`; a pointercancel → `cancel`. The page is handed the withheld
 *   press as a synthetic pointerdown/mousedown and every later event of the
 *   gesture passes through, so script-driven drags start as well.
 * - A press the browser itself counts as the 2nd/3rd click on the same
 *   element (its mousedown `detail` ≥ 2) continues a double/triple click: it
 *   is folded into the previous step (`merged`) instead of becoming its own,
 *   and its clicks plus the dblclick are replayed in order after that step's
 *   screenshot — or pass through natively if that click was already replayed.
 *   The browser's click count is the only judge: two separate clicks are
 *   always two steps, however close together they land.
 */

/** Pointer travel (CSS px) past which a held mouse/pen press is a drag. Kept
 * no larger than the browser's own drag-start distance so the gate classifies
 * the press before a native drag begins. */
export const STEP_DRAG_THRESHOLD_PX = 4;
/** Finger contacts jitter more than a mouse. */
export const STEP_TOUCH_DRAG_THRESHOLD_PX = 10;

/** Every event type the gate must observe, registered in the capture phase on
 * the recorded document. */
export const STEP_PRESS_GATE_EVENTS = [
  'pointermove',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'dragstart',
] as const;

/** `merged`: a multi-click follow-up folded into the previous step; it gets
 * no step of its own. */
export type StepPressOutcome = 'click' | 'drag' | 'cancel' | 'merged';

export interface StepPress {
  readonly target: Element;
  readonly clientX: number;
  readonly clientY: number;
  /** Settles once the press is classified. */
  readonly outcome: Promise<StepPressOutcome>;
}

interface PressRecord extends StepPress {
  readonly pointerId: number;
  readonly pointerType: string;
  /** 1 for the press that starts a step; n for the nth click of a multi-click. */
  clickCount: number;
  /** The step-owning press a multi-click follow-up was folded into. */
  owner: PressRecord | null;
  /** The click on the same element right before this press, which the
   * browser may report this press as continuing. */
  readonly previous: PressRecord | null;
  readonly followers: PressRecord[];
  state: 'held' | 'released' | 'passthrough';
  result: StepPressOutcome | null;
  /** The trusted click of this press has been consumed. */
  clickSeen: boolean;
  /** A trusted dblclick followed this press's click. */
  dblclick: boolean;
  replayed: boolean;
  /** The page cancelled the handed-over mousedown, i.e. it wanted the native
   * drag/selection suppressed. */
  pageCancelledDown: boolean;
  settle(outcome: StepPressOutcome): void;
}

export type StepPressBeginResult =
  | { kind: 'step'; press: StepPress }
  /** A multi-click follow-up: no new step may start for it. */
  | { kind: 'continuation' };

export interface StepPressGate {
  /** Call for EVERY trusted pointerdown, before any filtering: a new press
   * means the previous one was released, and ends its ownership of events. */
  onTrustedPointerDown(): void;
  /** Takes over a trusted primary pointerdown the recorder wants to record. */
  begin(event: PointerEvent, target: Element): StepPressBeginResult;
  /** Capture-phase listener for STEP_PRESS_GATE_EVENTS. */
  handleEvent(event: Event): void;
  /** Window blur: a button released outside the page never reports pointerup. */
  handleBlur(): void;
  /** Replays a click press, then every multi-click follow-up folded into it. */
  replay(press: StepPress): void;
  /** The press will never be captured (its queue entry was skipped or purged,
   * or the recorder is going away): give the page what it would otherwise
   * have received, without recording anything. */
  abandon(press: StepPress): void;
  /** Teardown: hands any withheld press back to the page. */
  clear(): void;
}

export interface StepPressGateOptions {
  lateClicks: LateClickSuppressor<Element>;
  /** True while an earlier step's capture is in flight or queued. Events that
   * belong to no tracked press (other buttons, keyboard clicks) are held back
   * from the page meanwhile, as they always were. */
  isBusy: () => boolean;
  /** Injected for tests: page-dispatched events are never trusted. */
  isTrusted?: (event: Event) => boolean;
}

/** True for input aimed at Howbeam's own UI (the recording toolbar, the
 * region selector). Closed shadow roots retarget to their host, which carries
 * the overlay marker, so the composed path always exposes it. */
export function isExtensionOverlayEvent(event: Event): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof Element && isExtensionOverlay(node)) return true;
  }
  return event.target instanceof Element && isExtensionOverlay(event.target);
}

const swallow = (event: Event): void => {
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
};

/** Hides an event from page scripts while its default action still runs. */
const hide = (event: Event): void => {
  event.stopImmediatePropagation();
};

const isPrimaryButton = (event: Event): boolean =>
  event.type === 'pointercancel' || (event as MouseEvent).button === 0;

export function createStepPressGate(options: StepPressGateOptions): StepPressGate {
  const { lateClicks, isBusy } = options;
  const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  /** The press that owns the trusted follow-up events arriving now. */
  let current: PressRecord | null = null;
  /** The latest press, kept for multi-click detection after ownership ends. */
  let last: PressRecord | null = null;

  const createRecord = (event: PointerEvent, target: Element, previous: PressRecord | null): PressRecord => {
    let resolve!: (outcome: StepPressOutcome) => void;
    const outcome = new Promise<StepPressOutcome>((done) => {
      resolve = done;
    });
    const record: PressRecord = {
      target,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clickCount: 1,
      owner: null,
      previous,
      followers: [],
      outcome,
      state: 'held',
      result: null,
      clickSeen: false,
      dblclick: false,
      replayed: false,
      pageCancelledDown: false,
      settle(next) {
        if (record.result !== null) return;
        record.result = next;
        resolve(next);
      },
    };
    return record;
  };

  const release = (press: PressRecord): void => {
    if (press.state !== 'held') return;
    press.state = 'released';
    press.settle('click');
  };

  /** Gives a withheld press back to the page: synthetic pointerdown (plus the
   * compatibility mousedown the browser would have fired), after which the
   * gesture's own trusted events flow through. */
  const handOver = (press: PressRecord, outcome: StepPressOutcome): void => {
    if (press.state === 'passthrough') return;
    press.state = 'passthrough';
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: press.clientX,
      clientY: press.clientY,
      button: 0,
      buttons: 1,
      detail: press.clickCount,
    };
    if (press.target.isConnected) {
      const pointerDown = new PointerEvent('pointerdown', {
        ...init,
        pointerId: press.pointerId,
        pointerType: press.pointerType,
        isPrimary: true,
      });
      press.target.dispatchEvent(pointerDown);
      // A cancelled pointerdown suppresses the compatibility mouse events.
      if (!pointerDown.defaultPrevented && press.pointerType !== 'touch') {
        const mouseDown = new MouseEvent('mousedown', init);
        press.target.dispatchEvent(mouseDown);
        press.pageCancelledDown = mouseDown.defaultPrevented;
      }
    }
    press.settle(outcome);
  };

  const travelled = (press: PressRecord, event: PointerEvent): boolean => {
    const limit = press.pointerType === 'touch' ? STEP_TOUCH_DRAG_THRESHOLD_PX : STEP_DRAG_THRESHOLD_PX;
    return Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > limit;
  };

  /** A finished click (or folded follow-up) a later press can continue. */
  const isClickPress = (press: PressRecord | null): press is PressRecord =>
    press !== null && (press.result === 'click' || press.result === 'merged');

  /**
   * Folds `press` into its predecessor's step once the browser reports it as
   * click number `count` (≥ 2) on the same element. Returns `native` when the
   * press now passes straight through to the page, `folded` when it is held
   * for the owner's replay, `none` when there is nothing to continue (the
   * browser counted clicks on another element).
   *
   * `handingDown`: the press's own trusted pointerdown/mousedown is being
   * dispatched right now and should simply reach the page if it passes through.
   */
  const fold = (
    press: PressRecord,
    count: number,
    handingDown: 'pointerdown' | 'mousedown',
  ): 'none' | 'folded' | 'native' => {
    const previous = press.previous;
    if (!isClickPress(previous) || press.owner !== null) return 'none';
    const owner = previous.owner ?? previous;
    press.owner = owner;
    press.clickCount = count;
    if (owner.replayed) {
      // The step's click already reached the page: this press continues it
      // natively, so the page sees the real click count and dblclick.
      press.state = 'passthrough';
      press.replayed = true;
      if (handingDown === 'mousedown' && press.target.isConnected) {
        // Its pointerdown was withheld before the browser's count was known.
        press.target.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: press.clientX,
          clientY: press.clientY,
          button: 0,
          buttons: 1,
          detail: count,
          pointerId: press.pointerId,
          pointerType: press.pointerType,
          isPrimary: true,
        }));
      }
    } else {
      owner.followers.push(press);
    }
    press.settle('merged');
    return press.state === 'passthrough' ? 'native' : 'folded';
  };

  const replayFollowers = (owner: PressRecord): void => {
    for (const follower of owner.followers) {
      if (follower.replayed) continue;
      follower.replayed = true;
      if (follower.state === 'held') {
        // Still pressed: from here on it is an ordinary native press.
        handOver(follower, 'cancel');
        continue;
      }
      if (follower.state !== 'released' || !follower.target.isConnected) continue;
      replayElementClick(follower.target, {
        clientX: follower.clientX,
        clientY: follower.clientY,
        detail: follower.clickCount,
        focus: false,
      });
      if (follower.dblclick) replayElementDoubleClick(follower.target, follower);
    }
  };

  const asRecord = (press: StepPress): PressRecord => press as PressRecord;

  const replay = (owner: PressRecord): void => {
    if (owner.replayed) return;
    owner.replayed = true;
    if (!owner.target.isConnected) return;
    // A trailing trusted click can still arrive after the gesture cleared;
    // suppress it so the page handler runs exactly once — from this replay.
    lateClicks.arm(owner.target);
    replayElementClick(owner.target, { clientX: owner.clientX, clientY: owner.clientY });
    replayFollowers(owner);
  };

  return {
    onTrustedPointerDown() {
      // Trusted events are ordered: a held press whose pointerup never reached
      // this document (release outside the window) is over now.
      if (current?.state === 'held') release(current);
      current = null;
    },

    begin(event, target) {
      const previous = isClickPress(last) && last.target === target ? last : null;
      const press = createRecord(event, target, previous);
      last = press;
      current = press;
      // Some engines already carry the click count on pointerdown; otherwise
      // the compatibility mousedown that follows reports it.
      const folded = event.detail >= 2 ? fold(press, event.detail, 'pointerdown') : 'none';
      if (folded !== 'none') {
        if (folded === 'folded') hide(event);
        return { kind: 'continuation' };
      }
      hide(event);
      if (opensNativePopupOnPress(target)) release(press);
      return { kind: 'step', press };
    },

    handleEvent(event) {
      if (!isTrusted(event)) return;
      // Howbeam's own controls must always receive their input, even while a
      // capture is in flight; they are never part of a recorded gesture.
      if (isExtensionOverlayEvent(event)) return;
      const press = current;

      if (event.type === 'pointermove') {
        if (press?.state !== 'held') return;
        const move = event as PointerEvent;
        if (move.pointerId !== press.pointerId) return;
        if ((move.buttons & 1) === 0) release(press);
        else if (travelled(press, move)) handOver(press, 'drag');
        return;
      }
      if (event.type === 'dragstart') {
        if (press?.state === 'held') handOver(press, 'drag');
        // The page cancelled the press it was handed, which natively would
        // have prevented this drag from ever starting.
        if (press?.pageCancelledDown) swallow(event);
        return;
      }
      if (event.type === 'click' && lateClicks.shouldSuppress(event.target, true, isArmedElementOrDescendant)) {
        swallow(event);
        return;
      }

      // A keyboard activation (detail 0) never belongs to a press, nor does
      // another finger's contact.
      const ownedByPress =
        press !== null &&
        isPrimaryButton(event) &&
        !(event instanceof PointerEvent && event.pointerId !== press.pointerId) &&
        !(event.type === 'click' && (event as MouseEvent).detail === 0) &&
        !(press.clickSeen && event.type !== 'dblclick');
      if (press && ownedByPress) {
        if (press.state === 'passthrough') {
          if (event.type === 'click') press.clickSeen = true;
          return;
        }
        switch (event.type) {
          case 'mousedown': {
            const count = (event as MouseEvent).detail;
            if (count >= 2 && fold(press, count, 'mousedown') === 'native') return;
            hide(event);
            return;
          }
          case 'pointerup':
          case 'mouseup':
            hide(event);
            release(press);
            return;
          case 'click':
            swallow(event);
            release(press);
            press.clickSeen = true;
            return;
          case 'dblclick': {
            const owner = press.owner ?? press;
            current = null;
            if (owner.replayed && press.replayed) return;
            swallow(event);
            press.dblclick = true;
            return;
          }
          case 'pointercancel':
            // The browser took the gesture over (scroll, native drag): the page
            // gets the press it was owed, then this cancel.
            handOver(press, 'cancel');
            return;
          default:
            break;
        }
      }
      if (isBusy()) swallow(event);
    },

    handleBlur() {
      if (current?.state === 'held') release(current);
    },

    replay(press) {
      replay(asRecord(press));
    },

    abandon(press) {
      const record = asRecord(press);
      // A folded follow-up belongs to its owner's step, which replays it.
      if (record.owner !== null) return;
      if (record.state === 'held') {
        handOver(record, 'cancel');
        return;
      }
      if (record.state === 'released') replay(record);
    },

    clear() {
      if (current?.state === 'held') handOver(current, 'cancel');
      current = null;
      last = null;
    },
  };
}

/** A dropdown `<select>` opens a native popup on mousedown that swallows the release. */
function opensNativePopupOnPress(target: Element): boolean {
  const select = target.closest('select');
  return select !== null && !select.disabled && !select.multiple && select.size <= 1;
}

/** True when a trusted click landed on the armed element or inside it. */
function isArmedElementOrDescendant(armed: Element, eventTarget: unknown): boolean {
  return armed === eventTarget || (eventTarget instanceof Node && armed.contains(eventTarget));
}

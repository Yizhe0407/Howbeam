import { createLateClickSuppressor, type LateClickSuppressor } from '../capture/step-capture';
import { createStepGestureQueue, type StepGesture, type StepGestureQueue } from '../capture/step-gesture-queue';
import { STEP_PRESS_GATE_EVENTS, createStepPressGate, type StepPress } from '../capture/step-press-gate';
import { isInScrollbarGutter, isPointInAnyScrollGutter } from './recording-guards';
import { STEP_LATE_CLICK_SUPPRESS_MS } from './content-script-constants';

/** What becomes of a held click once it is recorded (or not). */
export interface HeldPress {
  /** When the press happened (the step's timestamp), not when it was released. */
  pressedAt: number;
  /** Hands the click back to the page, after its screenshot is taken. */
  replay(): void;
  /** The click will never be recorded: give the page what it would have received. */
  abandon(): void;
}

export interface StepPressPipelineOptions {
  /** Further reasons to leave a press to the page untouched (paused run, Howbeam's own UI, ...). */
  ignore(event: PointerEvent): boolean;
  /** The element a press at this point records, or null to leave it to the page. */
  resolveTarget(clientX: number, clientY: number): Element | null;
  /** A press turned out to be a click: record it (capture here, or relay to the top frame). */
  deliver(gesture: StepGesture, press: StepPress, target: Element, held: HeldPress): Promise<void>;
  /** The press's gesture is about to wait for release (the top frame hides its hover box). */
  onGestureStart?(): void;
  /** The press was a drag or was cancelled: it already reached the page natively. */
  onNotAClick?(): void;
}

export interface StepPressPipeline {
  readonly gestureQueue: StepGestureQueue;
  readonly lateClicks: LateClickSuppressor<Element>;
  /** Detaches every listener and gives the page back whatever press is still held. */
  uninstall(): void;
}

/**
 * The one way a recorded press is handled, in the top frame and in child
 * frames alike: filter the pointerdown, take the press over synchronously
 * (see step-press-gate.ts), queue it behind earlier steps, and once released
 * either record it as a click or leave the drag to the page. Only target
 * resolution and delivery differ between frames.
 */
export function installStepPressPipeline(options: StepPressPipelineOptions): StepPressPipeline {
  const gestureQueue = createStepGestureQueue();
  const lateClicks = createLateClickSuppressor<Element>(STEP_LATE_CLICK_SUPPRESS_MS);
  const pressGate = createStepPressGate({ lateClicks, isBusy: () => gestureQueue.isBusy() });

  const run = async (gesture: StepGesture, press: StepPress, target: Element, pressedAt: number) => {
    options.onGestureStart?.();
    const kind = await Promise.race([press.outcome, gesture.cancelled.then(() => 'cancel' as const)]);
    if (kind !== 'click') {
      pressGate.abandon(press);
      gesture.release();
      options.onNotAClick?.();
      return;
    }
    await options.deliver(gesture, press, target, {
      pressedAt,
      replay: () => pressGate.replay(press),
      abandon: () => pressGate.abandon(press),
    });
  };

  const onPointerDown = (event: Event) => {
    const pointer = event as PointerEvent;
    if (!pointer.isTrusted) return;
    // Trusted events are ordered: this press ends the previous one and its
    // trailing-click era, so a rapid second click stays deliverable.
    pressGate.onTrustedPointerDown();
    lateClicks.onTrustedPointerDown();
    if (pointer.button !== 0 || !pointer.isPrimary) return;
    if (options.ignore(pointer)) return;
    // A press in a scrollbar gutter scrolls; it is never a step.
    if (isInScrollbarGutter(pointer.clientX, pointer.clientY, document.documentElement)) return;
    if (isPointInAnyScrollGutter(pointer.clientX, pointer.clientY)) return;
    const target = options.resolveTarget(pointer.clientX, pointer.clientY);
    if (!target) return;

    // Event dispatch never waits for an async listener, so the press is taken
    // over now: page scripts stop seeing it while the browser's own default
    // actions still run. Release decides whether it is a step.
    const begun = pressGate.begin(pointer, target);
    if (begun.kind === 'continuation') return;
    const { press } = begun;
    const pressedAt = Date.now();
    gestureQueue.enqueue({
      captureId: crypto.randomUUID(),
      validate: () => target.isConnected,
      onSkipped: () => pressGate.abandon(press),
      start: (gesture) => run(gesture, press, target, pressedAt),
    });
  };
  const onGateEvent = (event: Event) => pressGate.handleEvent(event);
  const onBlur = () => pressGate.handleBlur();

  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_PRESS_GATE_EVENTS) document.addEventListener(type, onGateEvent, { capture: true });
  window.addEventListener('blur', onBlur);

  return {
    gestureQueue,
    lateClicks,
    uninstall() {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      for (const type of STEP_PRESS_GATE_EVENTS) document.removeEventListener(type, onGateEvent, { capture: true });
      window.removeEventListener('blur', onBlur);
      // Whatever is capturing is cancelled; queued presses are handed back to
      // the page unrecorded, and a press still held gets its pointerdown back.
      gestureQueue.cancelActive();
      gestureQueue.purgePending();
      pressGate.clear();
      lateClicks.clear();
    },
  };
}

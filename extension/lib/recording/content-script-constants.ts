import { browser } from 'wxt/browser';
import { KEEPALIVE_PORT_NAME } from '../runtime/keep-alive';

/** The background matches keep-alive ports by this exact name; both sides
 * derive it from the canonical lib/runtime/keep-alive export. */
export const CONTENT_KEEPALIVE_PORT_NAME = KEEPALIVE_PORT_NAME;
export const CONTENT_KEEPALIVE_INTERVAL_MS = 20_000;

/** Budget for a recording control command (toolbar or shield) before the UI
 * gives up on the background. Shared by the in-page toolbar and the shield
 * page so both surfaces re-enable their controls on the same schedule. */
export const RECORDING_CONTROL_TIMEOUT_MS = 15_000;

export const STEP_FOLLOWUP_EVENTS = [
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
] as const;

/** Canonical budget for a hung step capture before the swallowed click is
 * replayed anyway. Only a genuinely hung capture should hit this; normal
 * latency captures (even throttled) settle well under it. The top frame times
 * out at exactly this value, and every child frame in the relay chain derives
 * its slightly larger local failsafe from it (see frame-relay.ts). */
export const CAPTURE_FAILSAFE_MS = 2_000;

/** Trailing-trusted-click suppression window, likewise shared by the top
 * frame and every instrumented child frame. */
export const STEP_LATE_CLICK_SUPPRESS_MS = 2_000;

export const CLEANUP_EVENT = `howbeam_cleanup_${browser.runtime.id}`;

/** Events a frozen snapshot page must consume before the input shield is
 * ready (and, in child frames, for the whole snapshot). Kept aligned with the
 * shield page's own freeze list so the pre-ready window has no gaps. */
export const SNAPSHOT_FREEZE_EVENTS = [
  'pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click',
  'dblclick', 'auxclick', 'contextmenu', 'submit', 'keydown', 'keyup', 'keypress',
  'beforeinput', 'input', 'wheel', 'touchstart', 'touchmove', 'touchend',
  'dragstart', 'drop', 'selectstart',
] as const;

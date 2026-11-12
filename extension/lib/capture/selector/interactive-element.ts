import { DECORATIVE_SVG_TAGS, isElementUnavailable } from './element-availability';

const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'area',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'details',
  'option',
  'object',
  'embed',
]);
/**
 * Attributes that bind a click through a delegation library or framework
 * template. Handlers registered with addEventListener are invisible to a
 * content script — the DevTools-only getEventListeners is not available to
 * extensions — so these markers are the practical evidence that a plain
 * div/span is a control. Without them a jsaction-driven page (all of Google's
 * products) reads as inert text.
 */
const DELEGATED_CLICK_ATTRIBUTES = [
  'jsaction',
  'data-action',
  'ng-click',
  'data-ng-click',
  'x-ng-click',
  'v-on:click',
  '@click',
  'wire:click',
  'hx-get',
  'hx-post',
  'hx-put',
  'hx-patch',
  'hx-delete',
] as const;
/** Attributes whose separator-prefixed values name the bound event type. */
const EVENT_QUALIFIED_ATTRIBUTES: Record<string, string> = { jsaction: ':', 'data-action': '->' };

const INLINE_POINTER_HANDLER_ATTRIBUTES = [
  'onclick',
  'onmousedown',
  'onmouseup',
  'onpointerdown',
  'onpointerup',
] as const;
/** ARIA state that only a widget carries; the element answers to activation
 * even when its role is implicit or supplied by an ancestor. */
const ARIA_WIDGET_STATE_ATTRIBUTES = ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected'] as const;

const POINTER_CURSORS = new Set(['pointer', 'zoom-in', 'zoom-out']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'tab',
  'switch',
  'option',
  'combobox',
  'gridcell',
  'listbox',
  'menu',
  'menubar',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'textbox',
  'treeitem',
]);

const KNOWN_ARIA_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'suggestion',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

export type InteractionKind = 'native' | 'role' | 'handler' | 'focusable' | 'cursor';

/**
 * Decides whether an event-qualified binding covers click. `jsaction` entries
 * read `eventType:namespace.action` and Stimulus `data-action` entries read
 * `event->controller#method`; in both, an entry without the separator defaults
 * to click, so `jsaction="menu.toggle"` and `data-action="menu#toggle"` count.
 */
function declaresClickBinding(value: string, separator: string): boolean {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const boundary = entry.indexOf(separator);
      return boundary < 0 || entry.slice(0, boundary).trim() === 'click';
    });
}

function hasDelegatedClickBinding(el: Element): boolean {
  return DELEGATED_CLICK_ATTRIBUTES.some((attribute) => {
    const value = el.getAttribute(attribute);
    if (value === null) return false;
    const separator = EVENT_QUALIFIED_ATTRIBUTES[attribute];
    return separator === undefined || declaresClickBinding(value, separator);
  });
}

function hasWidgetStateAttribute(el: Element): boolean {
  // aria-haspopup="false" is the documented way to say "no popup"; every other
  // state attribute stays meaningful at "false" because only a toggle has one.
  return (
    ARIA_WIDGET_STATE_ATTRIBUTES.some((attribute) => el.hasAttribute(attribute)) ||
    (el.getAttribute('aria-haspopup')?.trim().toLowerCase() ?? 'false') !== 'false'
  );
}

export function interactionKind(el: Element, style?: CSSStyleDeclaration): InteractionKind | null {
  const tag = el.tagName.toLowerCase();
  const isNative =
    INTERACTIVE_TAGS.has(tag) &&
    !(tag === 'input' && (el as HTMLInputElement).type === 'hidden') &&
    !((tag === 'a' || tag === 'area') && !el.hasAttribute('href')) &&
    !(tag === 'label' && el instanceof HTMLLabelElement && !el.control);
  if (isNative) return 'native';
  if ((el instanceof HTMLAudioElement || el instanceof HTMLVideoElement) && el.controls) return 'native';

  const roles = el.getAttribute('role')?.trim().toLowerCase().split(/\s+/) ?? [];
  const role = roles.find((candidate) => KNOWN_ARIA_ROLES.has(candidate));
  if (role && INTERACTIVE_ROLES.has(role)) return 'role';

  const contentEditable = el.getAttribute('contenteditable')?.trim().toLowerCase();
  const assignedClick = (el as Element & { onclick?: unknown }).onclick;
  if (
    INLINE_POINTER_HANDLER_ATTRIBUTES.some((attribute) => el.hasAttribute(attribute)) ||
    typeof assignedClick === 'function' ||
    hasDelegatedClickBinding(el) ||
    hasWidgetStateAttribute(el) ||
    contentEditable === '' ||
    contentEditable === 'true' ||
    contentEditable === 'plaintext-only'
  ) {
    return 'handler';
  }

  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return 'focusable';

  return POINTER_CURSORS.has((style ?? getComputedStyle(el)).cursor) ? 'cursor' : null;
}

export function isInteractiveElement(el: Element): boolean {
  return interactionKind(el) !== null && !isElementUnavailable(el);
}

export function isDecorativeLeaf(el: Element, kind: InteractionKind): boolean {
  const tag = el.tagName.toLowerCase();
  return DECORATIVE_SVG_TAGS.has(tag) && kind === 'cursor';
}

function attributeSelector(attribute: string): string {
  return `[${attribute.replace(/[^\w-]/g, (character) => `\\${character}`)}]`;
}

/**
 * Every marker that can make an element a control, as a CSS selector. It
 * over-selects on purpose — `isInteractiveElement` is the authority, and this
 * only has to avoid missing anything it would accept. Cursor-only controls
 * cannot be expressed here and stay pointer-reachable.
 */
export const INTERACTIVE_CANDIDATE_SELECTOR = [
  ...INTERACTIVE_TAGS,
  '[role]',
  '[tabindex]',
  '[contenteditable]',
  '[aria-haspopup]',
  ...DELEGATED_CLICK_ATTRIBUTES.map(attributeSelector),
  ...INLINE_POINTER_HANDLER_ATTRIBUTES.map(attributeSelector),
  ...ARIA_WIDGET_STATE_ATTRIBUTES.map(attributeSelector),
].join(',');

/**
 * The host element every in-page overlay this extension injects is built on.
 *
 * `all: initial` plus per-property `!important` is what keeps page CSS from
 * reaching the overlay: a site that styles `div { position: static }` or hides
 * elements by class must not be able to move or erase the recorder's UI.
 */

const BASE_DECLARATIONS: Record<string, string> = {
  all: 'initial',
  position: 'fixed',
  inset: '0',
  width: '100vw',
  height: '100vh',
  margin: '0',
  padding: '0',
  border: '0',
  display: 'block',
  background: 'transparent',
  'z-index': '2147483647',
};

/** Marks every host this extension injects. Hit-testing keys off it so the
 * recorder can never target its own UI. */
const OVERLAY_HOST_ATTRIBUTE = 'data-howbeam-overlay';

export function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

/** True for the extension's own overlays and anything inside them. Closed
 * shadow roots do not hide them from a hit test: the host is what
 * `elementFromPoint` retargets to, and the extension can pierce its own roots. */
export function isExtensionOverlay(element: Element): boolean {
  return element.closest(`[${OVERLAY_HOST_ATTRIBUTE}]`) !== null;
}

/**
 * @param popover Whether the host is shown through the top layer. Only pass
 * true for a host that calls `showPopover()`: the attribute hides the element
 * until it does.
 */
export function createViewportOverlayHost(
  attribute: string,
  declarations: Record<string, string> = {},
  { popover = false }: { popover?: boolean } = {},
): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(attribute, '');
  host.setAttribute(OVERLAY_HOST_ATTRIBUTE, '');
  if (popover) host.setAttribute('popover', 'manual');
  for (const [property, value] of Object.entries({ ...BASE_DECLARATIONS, ...declarations })) {
    setImportantStyle(host, property, value);
  }
  return host;
}

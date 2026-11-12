/** What kind of control a click landed on, read from the element itself. */
export const CONTROL_KINDS = [
  'link',
  'link-new-tab',
  'select',
  'text-field',
  'checkbox',
  'radio',
  'submit',
  'button',
  'input',
  'disclosure',
  'label',
  'element',
] as const;

export type ControlKind = (typeof CONTROL_KINDS)[number];

export function isControlKind(value: unknown): value is ControlKind {
  return typeof value === 'string' && (CONTROL_KINDS as readonly string[]).includes(value);
}

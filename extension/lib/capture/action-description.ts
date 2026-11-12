import { t } from '@/lib/shared/i18n';
import type { ControlKind } from '../runtime/control-kind';

export { CONTROL_KINDS, isControlKind, type ControlKind } from '../runtime/control-kind';

const ROLE_KINDS: Partial<Record<string, ControlKind>> = {
  link: 'link',
  button: 'button',
  checkbox: 'checkbox',
  switch: 'checkbox',
  menuitemcheckbox: 'checkbox',
  radio: 'radio',
  menuitemradio: 'radio',
  combobox: 'select',
  listbox: 'select',
  option: 'select',
  textbox: 'text-field',
  searchbox: 'text-field',
};

function isEditableAttribute(value: string | null): boolean {
  return value === '' || value === 'true' || value === 'plaintext-only';
}

function inputKind(input: HTMLInputElement): ControlKind {
  switch (input.type) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'submit':
    case 'image':
      return 'submit';
    case 'button':
    case 'reset':
      return 'button';
    case 'text':
    case 'search':
    case 'email':
    case 'url':
    case 'tel':
    case 'password':
    case 'number':
      return 'text-field';
    default:
      return 'input';
  }
}

/**
 * The control a recorded click acted on, from its native semantics (tag,
 * input type, link target) or else its ARIA role. Never reads page text, so
 * nothing the page shows ends up in a step description.
 */
export function controlKindOf(element: Element): ControlKind {
  const tag = element.tagName.toLowerCase();
  if (tag === 'a' || tag === 'area') {
    return (element as HTMLAnchorElement).target === '_blank' ? 'link-new-tab' : 'link';
  }
  if (tag === 'select' || tag === 'option') return 'select';
  if (tag === 'textarea') return 'text-field';
  if (tag === 'input') return inputKind(element as HTMLInputElement);
  if (tag === 'button') {
    const button = element as HTMLButtonElement;
    return button.type === 'submit' && button.form ? 'submit' : 'button';
  }
  if (tag === 'summary') return 'disclosure';
  if (tag === 'label') {
    const control = (element as HTMLLabelElement).control;
    if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
      return control.type;
    }
    return 'label';
  }
  const role = element.getAttribute('role')?.trim().toLowerCase().split(/\s+/u)[0];
  const byRole = role ? ROLE_KINDS[role] : undefined;
  if (byRole) return byRole;
  if (
    element instanceof HTMLElement &&
    (element.isContentEditable || isEditableAttribute(element.getAttribute('contenteditable')))
  ) {
    return 'text-field';
  }
  return 'element';
}

export interface ActionDescriptionCapture {
  intent: 'click' | 'mark';
  control: ControlKind;
}

/** A short description of the recorded action, from its intent and control kind alone. */
export function generateActionDescription({ intent, control }: ActionDescriptionCapture): string {
  if (intent === 'mark') return t().capture.markRegion;
  const copy = t().capture;
  switch (control) {
    case 'link':
      return copy.openLink;
    case 'link-new-tab':
      return copy.openNewTab;
    case 'select':
      return copy.selectOption;
    case 'text-field':
      return copy.typeInField;
    case 'checkbox':
      return copy.toggleCheckbox;
    case 'radio':
      return copy.selectRadio;
    case 'submit':
      return copy.submitForm;
    case 'button':
      return copy.clickButton;
    case 'input':
      return copy.useInput;
    case 'disclosure':
      return copy.toggleDisclosure;
    case 'label':
      return copy.clickLabel;
    case 'element':
      return copy.clickElement;
  }
}

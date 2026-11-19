import type { ClickCapture } from '../runtime/messages';
import { t } from '@/lib/shared/i18n';

export type ActionTitleCapture = Pick<ClickCapture, 'intent' | 'tagName' | 'text'>;

const CHECKBOX_HINT = /(?:^|\s)(?:check\s*box|checkbox)(?:\s|$)|核取方塊|勾選框|複選框/iu;
const RADIO_HINT = /(?:^|\s)(?:radio(?:\s+button)?)(?:\s|$)|單選按鈕|選項按鈕/iu;
const NEW_TAB_HINT = /(?:^|\s)(?:open\s+in\s+(?:a\s+)?new\s+tab|new\s+tab)(?:\s|$)|(?:在)?新分頁(?:中)?開啟|開啟新分頁/iu;
const MAX_LABEL_LENGTH = 40;

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

/** The element's name as the title shows it: one line, cut to a readable length. */
function titleLabel(text: string): string {
  const label = text.replace(/\s+/gu, ' ').trim();
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH).trimEnd()}…` : label;
}

function tagHasToken(tagName: string, token: string): boolean {
  return tagName === token || tagName.split(/[-_:]/u).includes(token);
}

function describesCheckbox(tagName: string, text: string): boolean {
  return tagHasToken(tagName, 'checkbox') || CHECKBOX_HINT.test(text);
}

function describesRadio(tagName: string, text: string): boolean {
  return tagHasToken(tagName, 'radio') || RADIO_HINT.test(text);
}

type TitleTemplate = (label: string) => string;

function actionTemplate(tagName: string, text: string): TitleTemplate {
  const copy = t().capture;
  // Prefer native element semantics over label hints. A link whose label
  // happens to mention a checkbox is still more reliably a link.
  if (tagName === 'a' || tagName === 'area' || tagHasToken(tagName, 'link')) return copy.openLink;
  if (tagName === 'select' || tagName === 'option' || tagHasToken(tagName, 'select')) return copy.selectOption;
  if (tagName === 'textarea' || tagHasToken(tagName, 'textarea')) return copy.typeInField;
  if (tagName === 'summary') return copy.toggleDisclosure;
  if (tagName === 'button') return copy.click;
  if (describesCheckbox(tagName, text)) return copy.toggleCheckbox;
  if (describesRadio(tagName, text)) return copy.selectRadio;
  if (tagName === 'input') return copy.typeInField;
  return copy.click;
}

/**
 * The title a recorded click starts with, such as "點擊 Generate". It names the
 * element by its accessible name, field label or visible text (never a typed
 * value), which the person can edit. A mark has no action to name, and a click
 * on an unnamed element gets no title rather than a generic one.
 */
export function generateActionTitle(capture: ActionTitleCapture): string {
  if (capture.intent === 'mark') return '';

  const tagName = normalize(capture.tagName);
  const isLink = tagName === 'a' || tagName === 'area' || tagHasToken(tagName, 'link');
  if (isLink && NEW_TAB_HINT.test(normalize(capture.text))) return t().capture.openNewTab;

  const label = titleLabel(capture.text);
  if (!label) return '';
  return actionTemplate(tagName, normalize(capture.text))(label);
}

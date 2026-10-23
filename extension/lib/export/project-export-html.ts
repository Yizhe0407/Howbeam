import { throwIfAborted } from '../shared/abort';
import type { ProjectSection } from '../project/project-sections';
import { type StepEntry } from '../storage/models';
import {
  DEFAULT_TITLE,
  IMAGE_MIME_TYPE,
  MADE_WITH,
  PROJECT_EXPORT_THEME,
  escapeProjectHtml,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type ProjectExportMetadata,
  type ProjectExportOptions,
} from './project-export-contract';
import { chooseAnnotationColumns } from './annotation-columns';
import { encodeBase64Parts } from './base64';
import { segmentText, wrapText } from './text-wrap';
import { entryHeading, renderEntryImages, type RenderedEntryContent } from './project-export-render';
import { documentLang, t } from '@/lib/shared/i18n';

/**
 * Generates a self-contained HTML publication. It uses only fixed template
 * markup and data-URI images; all metadata and descriptions pass through
 * text escaping before interpolation.
 *
 * The document is returned as a Blob assembled from parts: each screenshot's
 * base64 goes straight into its own Blob as soon as it is encoded, so neither
 * one document-sized string nor every image's base64 text is ever held in the
 * JS heap at once. Peak memory stays near the size of the output itself.
 */
export async function generateProjectHtml(
  entries: readonly StepEntry[],
  metadata: ProjectExportMetadata = {},
  options: ProjectExportOptions = {},
): Promise<Blob> {
  const { signal } = options;
  throwIfAborted(signal);

  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const description = textValue(metadata.description);
  const header = [
    `<h1>${escapeProjectHtml(title)}</h1>`,
    description ? `<p class="document-description">${htmlText(description)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const parts: BlobPart[] = [];
  // Text not yet pushed: consecutive fragments are joined before becoming a part.
  let pending = `<!doctype html>
<html lang="${documentLang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'">
<title>${escapeProjectHtml(title)}</title>
<style>
${BASE_STYLE}
</style>
</head>
<body>
<main class="document">
<header class="document-header">
${header}
</header>
`;

  const sections = sectionsByStartEntry(metadata.sections, entries);
  let separator = '';
  for await (const rendered of renderEntryImages(entries, signal)) {
    const section = sections.get(rendered.content.entryId);
    if (section) {
      pending += separator + renderHtmlSectionHeading(section);
      separator = '\n';
    }
    const [before, after = ''] = renderHtmlEntry(rendered.content, IMAGE_SRC_TOKEN).split(IMAGE_SRC_TOKEN);
    parts.push(`${pending}${separator}${before}data:${IMAGE_MIME_TYPE};base64,`);
    parts.push(new Blob(encodeBase64Parts(rendered.imageBytes, signal)));
    pending = after;
    separator = '\n';
  }
  throwIfAborted(signal);

  parts.push(`${pending}
<footer class="document-end">${MADE_WITH}</footer>
</main>
</body>
</html>
`);
  return new Blob(parts, { type: 'text/html;charset=utf-8' });
}

/** Marks where an image's data URI goes. It contains `<`, which escaped user
 * text can never produce, so it occurs exactly once per rendered entry. */
const IMAGE_SRC_TOKEN = '<image-src>';

function renderHtmlSectionHeading(section: ProjectSection): string {
  return `<h2 class="section-heading">${htmlText(section.title)}</h2>`;
}

function renderHtmlEntry(entry: RenderedEntryContent, imageSrc: string): string {
  const heading = entryHeading(entry);
  const alt = escapeProjectHtml(textOrDefault(entry.description, t().export.imageAlt));
  const annotations = entry.annotations.length > 0 ? renderHtmlAnnotations(entry) : '';

  return [
    `<section class="step">`,
    `<h3 class="step-title"><span class="step-number">${entry.ordinal}.</span>${heading ? `<span>${htmlText(heading)}</span>` : ''}</h3>`,
    `<figure><img src="${imageSrc}" alt="${alt}"></figure>`,
    annotations,
    `</section>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderHtmlAnnotations(entry: RenderedEntryContent): string {
  const texts = entry.annotations.map((annotation) => textOrDefault(annotation.description, t().export.missingDescription));
  const { listAttributes, spans } = annotationColumns(texts);
  const items = texts.map((text, index) => `<li${spans[index] ? ' data-span' : ''}>${htmlText(text)}</li>`).join('\n');
  return `<ol class="annotations"${listAttributes}>
${items}
</ol>`;
}

/** The document's geometry; the stylesheet and the marker columns are both computed from it. */
const PAGE = Object.freeze({
  /** Body text, in px. */
  fontSize: 16,
  lineHeight: 1.75,
  /** The document column at its widest, in px. */
  maxWidth: 760,
  /** Where a step's title, screenshot and markers start, in em. */
  stepIndent: 2.2,
});

/** The marker list's geometry, in em at the body size. */
const LIST = Object.freeze({
  /** The list at its widest: the document column less the step indent. */
  width: PAGE.maxWidth / PAGE.fontSize - PAGE.stepIndent,
  columnGap: 2,
  /** Room left of each description for its number. */
  marker: 1.4,
  itemGap: 0.25,
});

const WIDE_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/** Typical advance of each character in em for the document's sans-serif stack. */
function estimatedWidth(text: string): number {
  let width = 0;
  for (const grapheme of segmentText(text, 'grapheme')) {
    if (PICTOGRAPH.test(grapheme)) width += 1.4;
    else if (WIDE_CHARACTER.test(grapheme)) width += 1;
    else if (/\p{Lu}/u.test(grapheme)) width += 0.65;
    else width += 0.55;
  }
  return width;
}

const columnWidth = (columns: number) => (LIST.width - LIST.columnGap * (columns - 1)) / columns;

/**
 * Columns are chosen by the PDF's rule, for the document at its widest. The
 * document carries no script and the reader's fonts aren't known here, so the
 * descriptions are measured with typical character widths. The browser is given
 * the narrowest column that keeps every marker on as few lines as at that width,
 * so a window too narrow for it shows fewer columns instead of more wrapping.
 * A marker too long for a column spans the full width between them.
 */
function annotationColumns(texts: readonly string[]): { listAttributes: string; spans: boolean[] } {
  const { columns, lines, spans } = chooseAnnotationColumns(
    (count) => texts.map((text) => wrapText(estimatedWidth, text, columnWidth(count) - LIST.marker)),
    (lineCount) => lineCount * PAGE.lineHeight + LIST.itemGap,
  );
  if (columns === 1) return { listAttributes: '', spans };
  // `lines` holds one entry per text.
  const keepsLines = (width: number) =>
    texts.every((text, index) => spans[index] || wrapText(estimatedWidth, text, width).length <= lines[index]!.length);
  let narrow = 0;
  let wide = columnWidth(columns) - LIST.marker;
  while (wide - narrow > 0.05) {
    const middle = (narrow + wide) / 2;
    if (keepsLines(middle)) wide = middle;
    else narrow = middle;
  }
  return { listAttributes: ` data-columns style="columns: ${Math.ceil((wide + LIST.marker) * 10) / 10}em ${columns}"`, spans };
}

function htmlText(value: string): string {
  return escapeProjectHtml(value).replace(/\r\n?|\n/g, '<br>');
}

/** Pure black on paper: screen greys wash out in print. */
const PRINT_TEXT = '#000000';
const PRINT_TEXT_SECONDARY = '#333333';
const PRINT_TEXT_MUTED = '#555555';
const PRINT_LINE = '#bdbdbd';

/**
 * A formal document: white paper, black text, one strong rule under the
 * title, hairlines between sections, printed step numbers and a thin frame
 * around each screenshot. The red highlights in the screenshots are the only
 * colour. Follows the reader's dark scheme on screen and prints in black.
 */
const BASE_STYLE = `
:root {
  color-scheme: light dark;
  --paper: #ffffff;
  --text: ${PROJECT_EXPORT_THEME.text};
  --text-secondary: ${PROJECT_EXPORT_THEME.secondaryText};
  --text-muted: ${PROJECT_EXPORT_THEME.mutedText};
  --rule-strong: ${PROJECT_EXPORT_THEME.text};
  --rule: ${PROJECT_EXPORT_THEME.rule};
  --image-border: ${PROJECT_EXPORT_THEME.imageBorder};
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #17181a;
    --text: #e8e8e8;
    --text-secondary: #c4c4c4;
    --text-muted: #9a9a9a;
    --rule-strong: #e8e8e8;
    --rule: #3a3b3e;
    --image-border: #3a3b3e;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--paper); color: var(--text); }
body {
  font-family: ${PROJECT_EXPORT_THEME.fontFamily};
  font-size: ${PAGE.fontSize}px;
  line-height: ${PAGE.lineHeight};
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p, li { margin: 0; overflow-wrap: anywhere; }
.document { width: min(100% - 32px, ${PAGE.maxWidth}px); margin: 0 auto; padding: 56px 0 48px; }
.document-header { padding-bottom: 20px; border-bottom: 2px solid var(--rule-strong); }
h1 { font-size: 30px; line-height: 1.35; font-weight: 700; }
.document-description { margin-top: 10px; color: var(--text-secondary); }
.section-heading { margin-top: 44px; padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 21px; line-height: 1.45; font-weight: 700; }
.step { margin-top: 32px; }
.step-title { display: grid; grid-template-columns: ${PAGE.stepIndent}em minmax(0, 1fr); font-size: 17px; line-height: 1.7; font-weight: 600; }
.step-number { font-variant-numeric: tabular-nums; }
figure { margin: 14px 0 0 ${PAGE.stepIndent}em; }
img { display: block; max-width: 100%; height: auto; border: 1px solid var(--image-border); border-radius: ${PROJECT_EXPORT_THEME.imageRadius}px; }
.annotations { margin: 12px 0 0 ${PAGE.stepIndent}em; padding-left: ${LIST.marker}em; color: var(--text-secondary); }
.annotations li + li { margin-top: ${LIST.itemGap}em; }
.annotations[data-columns] { padding-left: 0; column-gap: ${LIST.columnGap}em; }
.annotations[data-columns] li { margin: 0 0 ${LIST.itemGap}em ${LIST.marker}em; break-inside: avoid; }
.annotations[data-columns] li[data-span] { column-span: all; }
.document-end { margin-top: 56px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--text-muted); font-size: 13px; text-align: center; }
@media (max-width: 560px) {
  .document { padding-top: 28px; }
  h1 { font-size: 25px; }
  .step-title { grid-template-columns: 1.8em minmax(0, 1fr); }
  figure, .annotations { margin-left: 0; }
}
@page { size: A4; margin: 18mm 16mm 20mm; }
@media print {
  :root {
    --paper: #ffffff;
    --text: ${PRINT_TEXT};
    --text-secondary: ${PRINT_TEXT_SECONDARY};
    --text-muted: ${PRINT_TEXT_MUTED};
    --rule-strong: ${PRINT_TEXT};
    --rule: ${PRINT_LINE};
    --image-border: ${PRINT_LINE};
  }
  body { font-size: 10.5pt; line-height: 1.7; }
  .document { width: 100%; padding: 0; }
  h1 { font-size: 20pt; }
  .section-heading { font-size: 14pt; break-after: avoid; page-break-after: avoid; }
  .step { break-inside: avoid; page-break-inside: avoid; }
  .step-title { font-size: 11.5pt; }
  img { max-height: 150mm; }
}
`;

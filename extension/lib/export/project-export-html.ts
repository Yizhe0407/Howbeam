import { throwIfAborted } from '../shared/abort';
import type { ProjectSection } from '../project/project-sections';
import { type StepEntry } from '../storage/models';
import {
  DEFAULT_TITLE,
  IMAGE_MIME_TYPE,
  MADE_WITH,
  PROJECT_EXPORT_THEME,
  escapeProjectHtml,
  formatProjectCreatedAt,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type ProjectExportMetadata,
  type ProjectExportOptions,
} from './project-export-contract';
import { encodeBase64Parts } from './base64';
import { renderEntryImages, type RenderedEntryContent } from './project-export-render';
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
  // renderEntryImages yields every entry or throws, so the count is known
  // before the first image is rendered.
  const metaParts = [t().export.stepCount(entries.length)];
  const createdAt = formatProjectCreatedAt(metadata.createdAt);
  if (createdAt) metaParts.push(t().export.createdAt(createdAt));
  const header = [
    `<h1>${escapeProjectHtml(title)}</h1>`,
    description ? `<p class="document-description">${htmlText(description)}</p>` : '',
    `<p class="document-meta">${metaParts.map((part) => `<span>${escapeProjectHtml(part)}</span>`).join('')}</p>`,
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
    const [before, after] = renderHtmlEntry(rendered.content, IMAGE_SRC_TOKEN).split(IMAGE_SRC_TOKEN);
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
  const heading = htmlText(textOrDefault(entry.description, t().export.missingDescription));
  const alt = escapeProjectHtml(textOrDefault(entry.description, t().export.imageAlt));
  const annotations = entry.annotations.length > 0 ? renderHtmlAnnotations(entry) : '';

  return [
    `<section class="step">`,
    `<h3 class="step-title"><span class="step-number">${entry.ordinal}.</span><span>${heading}</span></h3>`,
    `<figure><img src="${imageSrc}" alt="${alt}"></figure>`,
    annotations,
    `</section>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderHtmlAnnotations(entry: RenderedEntryContent): string {
  const items = entry.annotations
    .map((annotation) => `<li>${htmlText(textOrDefault(annotation.description, t().export.missingDescription))}</li>`)
    .join('\n');
  return `<ol class="annotations">
${items}
</ol>`;
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
  font-size: 16px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p, li { margin: 0; overflow-wrap: anywhere; }
.document { width: min(100% - 32px, 760px); margin: 0 auto; padding: 56px 0 48px; }
.document-header { padding-bottom: 20px; border-bottom: 2px solid var(--rule-strong); }
h1 { font-size: 30px; line-height: 1.35; font-weight: 700; }
.document-description { margin-top: 10px; color: var(--text-secondary); }
.document-meta { margin-top: 14px; color: var(--text-muted); font-size: 14px; }
.document-meta span + span::before { content: "・"; margin: 0 4px; }
.section-heading { margin-top: 44px; padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 21px; line-height: 1.45; font-weight: 700; }
.step { margin-top: 32px; }
.step-title { display: grid; grid-template-columns: 2.2em minmax(0, 1fr); font-size: 17px; line-height: 1.7; font-weight: 600; }
.step-number { font-variant-numeric: tabular-nums; }
figure { margin: 14px 0 0 2.2em; }
img { display: block; max-width: 100%; height: auto; border: 1px solid var(--image-border); }
.annotations { margin: 12px 0 0 2.2em; padding-left: 1.4em; color: var(--text-secondary); }
.annotations li + li { margin-top: 4px; }
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

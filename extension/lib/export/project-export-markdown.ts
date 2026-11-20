import { throwIfAborted } from '../shared/abort';
import { strToU8 } from 'fflate';
import { type StepEntry } from '../storage/models';
import { buildZipBlob, paddedZipOrdinal, type ZipFileWriter } from './streaming-zip';
import {
  DEFAULT_TITLE,
  escapeProjectMarkdown,
  projectExportFilename,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type ProjectExportMetadata,
  type ProjectExportOptions,
  type ProjectMarkdownArchive,
} from './project-export-contract';
import {
  hasAnnotationText,
  renderEntryImages,
  type RenderedEntryContent,
  type RenderedMarkdownEntry,
} from './project-export-render';
import { t } from '@/lib/shared/i18n';

/**
 * Builds a portable Markdown ZIP containing one Markdown document and every
 * composited project image under images/. The Markdown uses relative paths so
 * the archive remains editable without embedding large data URIs.
 */
export async function generateProjectMarkdownArchive(
  entries: readonly StepEntry[],
  metadata: ProjectExportMetadata = {},
  options: ProjectExportOptions = {},
): Promise<ProjectMarkdownArchive> {
  const { signal } = options;
  let imageCount = 0;
  const blob = await buildZipBlob(async (addFile) => {
    imageCount = await writeProjectMarkdown(addFile, entries, metadata, options);
  });
  throwIfAborted(signal);
  return { blob, markdownFilename: projectExportFilename(metadata, 'markdown'), imageCount };
}

/**
 * Writes one Project's Markdown document and images into an archive being
 * built, under `folder/` when given, so several Projects can share one ZIP.
 * The Markdown's image paths are relative to its own folder. Returns how many
 * images were written.
 */
export async function writeProjectMarkdown(
  addFile: ZipFileWriter,
  entries: readonly StepEntry[],
  metadata: ProjectExportMetadata = {},
  options: ProjectExportOptions & { folder?: string } = {},
): Promise<number> {
  const { signal, folder } = options;
  const prefix = folder ? `${folder}/` : '';
  const markdownEntries: RenderedMarkdownEntry[] = [];
  for await (const rendered of renderEntryImages(entries, signal)) {
    const imageReference = `images/${paddedZipOrdinal(rendered.content.ordinal, entries.length)}.jpg`;
    addFile(`${prefix}${imageReference}`, rendered.imageBytes);
    markdownEntries.push({ ...rendered.content, imageReference });
  }

  throwIfAborted(signal);
  const markdown = renderProjectMarkdown(
    markdownEntries,
    entries,
    metadata,
    (entry) => entry.imageReference,
  );
  addFile(`${prefix}${projectExportFilename(metadata, 'markdown')}`, strToU8(markdown));
  return markdownEntries.length;
}

function renderProjectMarkdown<T extends RenderedEntryContent>(
  renderedEntries: readonly T[],
  sourceEntries: readonly StepEntry[],
  metadata: ProjectExportMetadata,
  imageReference: (entry: T) => string,
): string {
  const title = textOrDefault(metadata.title, DEFAULT_TITLE);
  const lines = [`# ${escapeProjectMarkdown(title)}`];
  const description = textValue(metadata.description);
  if (description) lines.push('', escapeProjectMarkdown(description));

  const sections = sectionsByStartEntry(metadata.sections, sourceEntries);
  for (const entry of renderedEntries) {
    const section = sections.get(entry.entryId);
    if (section) {
      lines.push('', `## ${escapeProjectMarkdown(section.title)}`);
    }
    // Same reading order as the HTML and PDF publications: numbered title,
    // screenshot, markers, then the description. Empty parts are left out.
    lines.push('', `### ${entry.ordinal}.${entry.title ? ` ${escapeProjectMarkdown(entry.title)}` : ''}`);
    const alt = textOrDefault(entry.title, t().export.imageAlt);
    lines.push('', `![${escapeProjectMarkdown(alt)}](${imageReference(entry)})`);
    if (hasAnnotationText(entry.annotations)) {
      lines.push('');
      for (const [index, annotation] of entry.annotations.entries()) {
        lines.push(`${index + 1}. ${escapeProjectMarkdown(textValue(annotation.description))}`.trimEnd());
      }
    }
    if (entry.description) lines.push('', escapeProjectMarkdown(entry.description));
  }

  return `${lines.join('\n')}\n`;
}


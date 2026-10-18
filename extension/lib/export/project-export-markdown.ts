import { throwIfAborted } from '../shared/abort';
import { strToU8 } from 'fflate';
import { type StepEntry } from '../storage/models';
import { buildZipBlob, paddedZipOrdinal } from './streaming-zip';
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
  entryHeading,
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
  const markdownEntries: RenderedMarkdownEntry[] = [];
  const markdownFilename = projectExportFilename(metadata, 'markdown');

  const blob = await buildZipBlob(async (addFile) => {
    for await (const rendered of renderEntryImages(entries, signal)) {
      const imageReference = `images/${paddedZipOrdinal(rendered.content.ordinal, entries.length)}.jpg`;
      addFile(imageReference, rendered.imageBytes);
      markdownEntries.push({ ...rendered.content, imageReference });
    }

    throwIfAborted(signal);
    const markdown = renderProjectMarkdown(
      markdownEntries,
      entries,
      metadata,
      (entry) => entry.imageReference,
    );
    addFile(markdownFilename, strToU8(markdown));
  });
  throwIfAborted(signal);
  return { blob, markdownFilename, imageCount: markdownEntries.length };
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
    // Text-first reading order matches the HTML and PDF publications: the step
    // description leads, its screenshot follows, then any group annotations.
    const heading = entryHeading(entry);
    if (heading) lines.push('', escapeProjectMarkdown(heading));
    const alt = textOrDefault(entry.description, t().export.imageAlt);
    lines.push('', `![${escapeProjectMarkdown(alt)}](${imageReference(entry)})`);
    if (entry.annotations.length > 0) {
      lines.push('');
      for (const [index, annotation] of entry.annotations.entries()) {
        lines.push(`${index + 1}. ${escapeProjectMarkdown(textOrDefault(annotation.description, t().export.missingDescription))}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}


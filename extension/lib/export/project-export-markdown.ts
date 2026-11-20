import { throwIfAborted } from '../shared/abort';
import { strToU8 } from 'fflate';
import { type StepEntry } from '../storage/models';
import { buildZipBlob, paddedZipOrdinal, type ZipFileWriter } from './streaming-zip';
import {
  DEFAULT_TITLE,
  escapeProjectMarkdown,
  hasPartHeadings,
  projectExportFilename,
  projectPublication,
  sectionsByStartEntry,
  textOrDefault,
  textValue,
  type ProjectExportMetadata,
  type ProjectExportOptions,
  type ProjectMarkdownArchive,
  type Publication,
} from './project-export-contract';
import {
  hasAnnotationText,
  renderEntryImages,
  withPartErrors,
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
  return generatePublicationMarkdownArchive(projectPublication(entries, metadata), options);
}

export async function generatePublicationMarkdownArchive(
  publication: Publication,
  options: ProjectExportOptions = {},
): Promise<ProjectMarkdownArchive> {
  const { signal } = options;
  let imageCount = 0;
  const blob = await buildZipBlob(async (addFile) => {
    imageCount = await writePublicationMarkdown(addFile, publication, options);
  });
  throwIfAborted(signal);
  return { blob, markdownFilename: projectExportFilename(publication, 'markdown'), imageCount };
}

/**
 * Writes a publication's Markdown document and images into an archive being
 * built, under `folder/` when given, so several documents can share one ZIP.
 * Image paths are relative to the document's own folder. Titled parts (the
 * Projects of a merged Series) get a heading each, with sections and steps one
 * level below, and their images are named by part and step. Returns how many
 * images were written.
 */
export async function writePublicationMarkdown(
  addFile: ZipFileWriter,
  publication: Publication,
  options: ProjectExportOptions & { folder?: string } = {},
): Promise<number> {
  const { signal, folder } = options;
  const prefix = folder ? `${folder}/` : '';
  const depth = hasPartHeadings(publication) ? 1 : 0;
  const lines = [`# ${escapeProjectMarkdown(textOrDefault(publication.title, DEFAULT_TITLE))}`];
  const description = textValue(publication.description);
  if (description) lines.push('', escapeProjectMarkdown(description));

  let imageCount = 0;
  for (const [partIndex, part] of publication.parts.entries()) {
    await withPartErrors(part, async () => {
      if (part.title !== undefined) {
        lines.push('', `## ${escapeProjectMarkdown(part.title)}`);
        const partDescription = textValue(part.description);
        if (partDescription) lines.push('', escapeProjectMarkdown(partDescription));
      }
      const sections = sectionsByStartEntry(part.sections, part.entries);
      const imagePrefix = depth ? `${paddedZipOrdinal(partIndex + 1, publication.parts.length)}-` : '';
      for await (const rendered of renderEntryImages(part.entries, signal)) {
        const imageReference = `images/${imagePrefix}${paddedZipOrdinal(rendered.content.ordinal, part.entries.length)}.jpg`;
        addFile(`${prefix}${imageReference}`, rendered.imageBytes);
        imageCount += 1;
        const section = sections.get(rendered.content.entryId);
        if (section) lines.push('', `${'#'.repeat(2 + depth)} ${escapeProjectMarkdown(section.title)}`);
        lines.push(...renderMarkdownEntry({ ...rendered.content, imageReference }, depth));
      }
    });
  }

  throwIfAborted(signal);
  addFile(`${prefix}${projectExportFilename(publication, 'markdown')}`, strToU8(`${lines.join('\n')}\n`));
  return imageCount;
}

/** Same reading order as the HTML and PDF publications: numbered title,
 * screenshot, markers, then the description. Empty parts are left out. */
function renderMarkdownEntry(entry: RenderedMarkdownEntry, depth: number): string[] {
  const lines = ['', `${'#'.repeat(3 + depth)} ${entry.ordinal}.${entry.title ? ` ${escapeProjectMarkdown(entry.title)}` : ''}`];
  const alt = textOrDefault(entry.title, t().export.imageAlt);
  lines.push('', `![${escapeProjectMarkdown(alt)}](${entry.imageReference})`);
  if (hasAnnotationText(entry.annotations)) {
    lines.push('');
    for (const [index, annotation] of entry.annotations.entries()) {
      lines.push(`${index + 1}. ${escapeProjectMarkdown(textValue(annotation.description))}`.trimEnd());
    }
  }
  if (entry.description) lines.push('', escapeProjectMarkdown(entry.description));
  return lines;
}

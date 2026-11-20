import { useEffect, useState } from 'react';
import { buildStepEntries, type StepEntry } from '@/lib/storage/models';
import { getSteps } from '@/lib/storage/step-repository';
import EntryPreview from '@/components/editor/EntryPreview';

/** Cover cards stay under 32rem wide before the grid adds a column; this covers them at 2 device pixels per CSS pixel. */
const COVER_PIXEL_WIDTH = 1024;

interface Props {
  projectId: string;
  /** Reloads the cover when the project's content changes. */
  revision: number;
}

/** A project's first screenshot, drawn the way the editor rail draws it, so masks and crops apply here too. */
export default function ProjectCover({ projectId, revision }: Props) {
  const [entry, setEntry] = useState<StepEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSteps(projectId).then((steps) => {
      if (!cancelled) setEntry(buildStepEntries(steps)[0] ?? null);
    }).catch((error: unknown) => {
      console.error('[howbeam] failed to load project cover', error);
    });
    return () => { cancelled = true; };
  }, [projectId, revision]);

  return (
    <div className="aspect-[16/9] w-full overflow-hidden border-b-2 border-border bg-secondary">
      {entry && (
        <EntryPreview
          entry={entry}
          alt=""
          fit="cover"
          badges={false}
          maxPixelWidth={COVER_PIXEL_WIDTH}
          className="size-full"
        />
      )}
    </div>
  );
}

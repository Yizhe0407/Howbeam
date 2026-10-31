import { useEffect, useState } from 'react';
import { buildStepEntries, type StepEntry } from '@/lib/storage/models';
import { getSteps } from '@/lib/storage/step-repository';
import EntryThumbnail from '@/components/editor/EntryThumbnail';

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
        <EntryThumbnail
          entry={entry}
          alt=""
          fit="cover"
          badges={false}
          loading="lazy"
          decoding="async"
          className="size-full"
        />
      )}
    </div>
  );
}

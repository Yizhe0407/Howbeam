import { refreshProjectSummary, requireWritableProject, runProjectStepsWrite } from '@/lib/storage/database';
import { sanitizeStepForStorage, type Step } from '@/lib/storage/models';
import { ensureProject } from '@/lib/storage/project-repository';

/** Stores rows exactly as given (their own order, no re-densifying), creating
 * the Project if needed: test data, not a capture. */
export async function seedSteps(steps: readonly Step[]): Promise<void> {
  if (steps.length === 0) return;
  const { sessionId, timestamp } = steps[0];
  await ensureProject(sessionId, timestamp);
  await runProjectStepsWrite(async (tx) => {
    const project = await requireWritableProject(tx, sessionId);
    for (const step of steps) await tx.objectStore('steps').add(sanitizeStepForStorage(step));
    await refreshProjectSummary(tx, project);
  });
}

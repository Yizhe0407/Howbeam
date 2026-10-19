interface ScriptTarget {
  tabId: number;
  allFrames?: boolean;
}

type ExecuteScript = (target: ScriptTarget) => Promise<unknown>;

/** Injects every accessible snapshot frame, falling back to a guaranteed
 * top-frame recorder when one inaccessible child rejects allFrames. */
export async function injectRecorderScript(
  executeScript: ExecuteScript,
  tabId: number,
  allFrames = false,
): Promise<void> {
  if (!allFrames) {
    await executeScript({ tabId });
    return;
  }
  try {
    await executeScript({ tabId, allFrames: true });
  } catch (error) {
    // activeTab always permits the top document, while a cross-origin child
    // may lack optional host access. The top recorder can still fall back to
    // that child iframe's visible outer bounds.
    console.warn('[howbeam] some child frames could not be instrumented; using iframe bounds', error);
    await executeScript({ tabId });
  }
}

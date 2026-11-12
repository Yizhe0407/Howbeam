/**
 * How long anything removed can be put back: a removed capture during a
 * recording (the background keeps its row, the toolbar offers Restore) and an
 * edit in the editor (its undo notice).
 */
export const UNDO_WINDOW_MS = 5_000;

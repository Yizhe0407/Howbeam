import { describeBrowserError } from './browser-errors';

export async function withMessageFailureFallback<T>(
  operation: Promise<T>,
  label: string,
  fallback: T,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    console.error(`[howbeam] ${label}:`, describeBrowserError(error), error);
    return fallback;
  }
}

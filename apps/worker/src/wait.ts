/**
 * Bounded waiting.
 *
 * A stop request has to end the process even when the step it interrupted never
 * settles, and a worker that waited forever for an aborted model stream would
 * hold its lease and its container open. Every wait in this package is therefore
 * expressed as "did it settle inside this window?".
 */

/** Resolves as soon as `work` settles either way; `false` when the window closed first. */
export async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

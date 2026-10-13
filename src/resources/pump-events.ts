// a next() parked on the transport never sees the abort, so the iterator is closed with return()
export async function pumpEvents<T>(
  events: AsyncIterable<T>,
  signal: AbortSignal,
  onEvent: (event: T) => void,
): Promise<void> {
  const iterator = events[Symbol.asyncIterator]();
  const close = () => void Promise.resolve(iterator.return?.()).catch(() => {});
  if (signal.aborted) {
    close();
    return;
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    while (true) {
      const next = await iterator.next();
      if (signal.aborted || next.done) return;
      onEvent(next.value);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', close);
  }
}

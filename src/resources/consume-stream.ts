import { pumpEvents } from './pump-events';

/** For per-event side effects; template state belongs to `orpcStreamResource` */
export function consumeStream<T>(opts: {
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>;
  onEvent: (event: T) => void;
  onFatal?: (error: unknown) => void;
}): { abort(): void } {
  const controller = new AbortController();
  const { signal } = controller;
  void (async () => {
    try {
      const events = await opts.open(signal);
      await pumpEvents(events, signal, (event) => {
        try {
          opts.onEvent(event);
        } catch (error) {
          // a handler bug is not a transport failure
          reportError(error);
        }
      });
    } catch (error) {
      if (signal.aborted) return;
      opts.onFatal?.(error);
    }
  })();
  return { abort: () => controller.abort() };
}

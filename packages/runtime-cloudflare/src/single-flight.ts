/**
 * Shares one in-flight start between concurrent callers. A Durable Object can
 * receive fetches, socket messages, and alarms while it is still starting, and
 * each would otherwise build its own authority over the same storage. A failed
 * start is forgotten so the next caller retries it.
 */
export function singleFlight(): <A>(start: () => Promise<A>) => Promise<A> {
  let inFlight: Promise<unknown> | undefined;
  return <A>(start: () => Promise<A>): Promise<A> => {
    if (inFlight === undefined) {
      inFlight = start().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight as Promise<A>;
  };
}

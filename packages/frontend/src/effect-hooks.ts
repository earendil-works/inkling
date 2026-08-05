import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Fiber } from "effect";
import type { RuntimeFiber } from "effect/Fiber";

import { browserRuntime } from "./effect-runtime.ts";

export type EffectQueryState<A, E> =
  | { readonly status: "loading"; readonly data: A | undefined }
  | { readonly status: "success"; readonly data: A }
  | { readonly status: "failure"; readonly data: A | undefined; readonly error: E };

export interface EffectQuery<A, E> {
  readonly state: EffectQueryState<A, E>;
  readonly refresh: () => void;
}

/** Runs a keyed Effect as a cancellable React query. */
export function useEffectQuery<A, E>(
  query: Effect.Effect<A, E>,
  queryKey: string,
): EffectQuery<A, E> {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<EffectQueryState<A, E>>({
    data: undefined,
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setState((current) => ({ data: current.data, status: "loading" }));
    const fiber = browserRuntime.runFork(
      query.pipe(
        Effect.match({
          onFailure: (error) => {
            if (active) setState((current) => ({ data: current.data, error, status: "failure" }));
          },
          onSuccess: (data) => {
            if (active) setState({ data, status: "success" });
          },
        }),
      ),
    );
    return () => {
      active = false;
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [queryKey, refreshVersion]);

  return {
    refresh: useCallback(() => setRefreshVersion((version) => version + 1), []),
    state,
  };
}

export interface EffectActionState<E> {
  readonly error: E | undefined;
  readonly pending: boolean;
}

export interface EffectActionCallbacks<A, E> {
  readonly onFailure?: ((error: E) => void) | undefined;
  readonly onSuccess?: ((value: A) => void) | undefined;
}

export interface EffectAction<I, A, E> {
  readonly execute: (input: I, callbacks?: EffectActionCallbacks<A, E>) => void;
  readonly reset: () => void;
  readonly state: EffectActionState<E>;
}

/** Runs user-initiated Effects and interrupts outstanding work on unmount. */
export function useEffectAction<I, A, E>(
  operation: (input: I) => Effect.Effect<A, E>,
): EffectAction<I, A, E> {
  const operationRef = useRef(operation);
  operationRef.current = operation;
  const fiberRef = useRef<RuntimeFiber<void, never> | undefined>(undefined);
  const mountedRef = useRef(true);
  const [state, setState] = useState<EffectActionState<E>>({ error: undefined, pending: false });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const fiber = fiberRef.current;
      if (fiber !== undefined) browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  const execute = useCallback((input: I, callbacks: EffectActionCallbacks<A, E> = {}) => {
    const previous = fiberRef.current;
    if (previous !== undefined) browserRuntime.runFork(Fiber.interrupt(previous));
    setState({ error: undefined, pending: true });
    fiberRef.current = browserRuntime.runFork(
      operationRef.current(input).pipe(
        Effect.match({
          onFailure: (error) => {
            if (!mountedRef.current) return;
            setState({ error, pending: false });
            callbacks.onFailure?.(error);
          },
          onSuccess: (value) => {
            if (!mountedRef.current) return;
            setState({ error: undefined, pending: false });
            callbacks.onSuccess?.(value);
          },
        }),
      ),
    );
  }, []);

  return {
    execute,
    reset: useCallback(() => setState({ error: undefined, pending: false }), []),
    state,
  };
}

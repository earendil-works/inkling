import { Layer, ManagedRuntime } from "effect";

/** The single Effect runtime used by the browser application. */
export const browserRuntime = ManagedRuntime.make(Layer.empty);

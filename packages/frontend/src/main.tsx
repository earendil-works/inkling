import { createRoot } from "react-dom/client";
import { Effect } from "effect";

import { App } from "./app.tsx";
import { browserRuntime } from "./effect-runtime.ts";

const rootElement = document.querySelector<HTMLElement>("#root");
if (rootElement === null) throw new Error("Missing React root element.");

const root = createRoot(rootElement);
root.render(<App />);

window.addEventListener("beforeunload", () => {
  root.unmount();
  Effect.runFork(browserRuntime.disposeEffect);
});

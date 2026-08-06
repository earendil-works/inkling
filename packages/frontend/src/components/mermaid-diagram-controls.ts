interface MermaidControlButton {
  readonly element: HTMLButtonElement;
  readonly kind: "reset" | "zoom-in" | "zoom-out";
}

export function mountMermaidDiagramError(diagram: HTMLElement): void {
  if (diagram.dataset["mermaidError"] !== undefined) return;
  diagram.dataset["mermaidError"] = "";
  diagram.querySelector(":scope > .jot-mermaid__controls")?.remove();
  const message = document.createElement("p");
  message.className = "jot-mermaid__error";
  message.textContent = "Diagram preview unavailable — showing Mermaid source.";
  diagram.prepend(message);
}

export function mountMermaidDiagramControls(diagram: HTMLElement, svg: string): void {
  const viewport = document.createElement("div");
  viewport.className = "mermaid-viewport";
  viewport.innerHTML = svg;

  const controls = document.createElement("div");
  controls.className = "jot-mermaid__controls";
  const buttons = [
    makeControlButton("zoom-in", "Zoom in", "+"),
    makeControlButton("zoom-out", "Zoom out", "−"),
    makeControlButton("reset", "Reset diagram", "Reset"),
  ] as const;
  controls.append(...buttons.map(({ element }) => element));
  diagram.replaceChildren(viewport, controls);

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragStart: { readonly x: number; readonly y: number } | undefined;
  const applyTransform = (): void => {
    viewport.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };

  for (const { element, kind } of buttons) {
    element.addEventListener("click", () => {
      switch (kind) {
        case "zoom-in":
          scale = Math.min(4, scale + 0.2);
          break;
        case "zoom-out":
          scale = Math.max(0.4, scale - 0.2);
          break;
        case "reset":
          scale = 1;
          offsetX = 0;
          offsetY = 0;
          break;
      }
      applyTransform();
    });
  }

  viewport.addEventListener("pointerdown", (event) => {
    dragStart = { x: event.clientX - offsetX, y: event.clientY - offsetY };
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (dragStart === undefined) return;
    offsetX = event.clientX - dragStart.x;
    offsetY = event.clientY - dragStart.y;
    applyTransform();
  });
  const finishDrag = (event: PointerEvent): void => {
    dragStart = undefined;
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener("pointercancel", finishDrag);
  viewport.addEventListener("pointerup", finishDrag);
}

function makeControlButton(
  kind: MermaidControlButton["kind"],
  label: string,
  text: string,
): MermaidControlButton {
  const element = document.createElement("button");
  element.type = "button";
  element.ariaLabel = label;
  element.textContent = text;
  element.dataset[mermaidControlDatasetKey(kind)] = "";
  return { element, kind };
}

function mermaidControlDatasetKey(kind: MermaidControlButton["kind"]): string {
  switch (kind) {
    case "zoom-in":
      return "mermaidZoomIn";
    case "zoom-out":
      return "mermaidZoomOut";
    case "reset":
      return "mermaidReset";
  }
}

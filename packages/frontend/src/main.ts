import type { HealthResponse } from "@earendil-works/jot-protocol";

const statusElement = requireElement<HTMLElement>("[data-api-status]");
const protocolElement = requireElement<HTMLElement>("[data-protocol]");

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    isRecord(value) &&
    value["service"] === "jot" &&
    value["status"] === "ok" &&
    typeof value["version"] === "string" &&
    typeof value["protocolVersion"] === "number"
  );
}

async function refreshApiStatus(): Promise<void> {
  try {
    const response = await fetch("/api/health", {
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();

    if (!response.ok || !isHealthResponse(payload)) {
      throw new Error("Unexpected health response");
    }

    document.documentElement.dataset["api"] = "ready";
    statusElement.textContent = `Local authority ready / ${payload.version}`;
    protocolElement.textContent = `Protocol ${payload.protocolVersion}`;
  } catch {
    document.documentElement.dataset["api"] = "unavailable";
    statusElement.textContent = "Local authority unavailable";
    protocolElement.textContent = "Protocol —";
  }
}

await refreshApiStatus();

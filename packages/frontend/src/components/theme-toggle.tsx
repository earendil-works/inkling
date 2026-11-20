import { useEffect, useSyncExternalStore } from "react";

import { DarkModeIcon, LightModeIcon } from "@earendil-works/elanor-icons-react";
import { IconButton } from "@earendil-works/elanor-react";

import {
  applyColorScheme,
  currentColorScheme,
  serverColorScheme,
  subscribeToColorScheme,
  syncThemeColor,
} from "./color-scheme.ts";

/** Switches between the light and dark theme; in the header, and in the wiki's navigation. */
export function ThemeToggle(): React.JSX.Element {
  const scheme = useSyncExternalStore(
    subscribeToColorScheme,
    currentColorScheme,
    serverColorScheme,
  );
  useEffect(() => syncThemeColor(), [scheme]);
  const nextScheme = scheme === "dark" ? "light" : "dark";
  return (
    <IconButton
      aria-label={`Switch to ${nextScheme} theme`}
      data-theme-toggle=""
      onClick={(event) => {
        if (event.detail <= 1) toggleScheme();
      }}
    >
      {scheme === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
    </IconButton>
  );
}

function toggleScheme(): void {
  applyColorScheme(currentColorScheme() === "dark" ? "light" : "dark", true);
}

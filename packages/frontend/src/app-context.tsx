import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { PresenceDto } from "@earendil-works/inkling-protocol";

import type { ConnectionState } from "./collaboration.ts";
import type { NavigateOptions } from "./navigation.ts";

export interface AppStatus {
  readonly label: string;
  readonly state: ConnectionState;
}

export type ToastKind = "error" | "success";

export interface HeaderDocument {
  readonly id: string;
  readonly rfcNumber?: number | undefined;
  readonly title: string;
}

export interface AppContextValue {
  readonly navigate: (destination: string | URL, options?: NavigateOptions) => void;
  readonly refreshRoute: () => void;
  readonly setHeaderDocument: Dispatch<SetStateAction<HeaderDocument | undefined>>;
  readonly setParticipants: Dispatch<SetStateAction<readonly PresenceDto[]>>;
  readonly setStatus: Dispatch<SetStateAction<AppStatus | undefined>>;
  readonly showToast: (message: string, kind: ToastKind) => void;
}

export const AppContext = createContext<AppContextValue | undefined>(undefined);

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (value === undefined) throw new Error("AppContext is unavailable.");
  return value;
}

import { useContext } from "react";

import { AppContext } from "./appContextValue";
import type { AppContextValue } from "./appContextValue";

export function useAppContext(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useAppContext must be used within AppProvider");
  }
  return context;
}

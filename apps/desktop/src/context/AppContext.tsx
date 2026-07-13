import { useReducer } from "react";
import type { ReactNode } from "react";

import { AppContext, initialState, reducer } from "./appContextValue";

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

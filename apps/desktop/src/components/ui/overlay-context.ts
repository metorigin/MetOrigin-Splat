import { createContext, useContext } from "react";

// Menus and tooltips opened in a dialog belong to its accessible subtree.
export const OverlayContainerContext = createContext<HTMLElement | undefined>(undefined);
export const useOverlayContainer = () => useContext(OverlayContainerContext);

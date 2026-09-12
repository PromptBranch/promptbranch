import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme";
import { RendererRoot } from "./RendererRoot";
import "./index.css";

// Applies the stored theme (data-theme on <html>) before React renders;
// index.html already set it pre-paint for the no-flash path.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RendererRoot />
  </StrictMode>,
);

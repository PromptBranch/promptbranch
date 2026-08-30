import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { initTheme } from "./lib/theme";
import { ToastProvider } from "./lib/toast";
import { AppStateProvider } from "./state/app-state";
import "./index.css";

// Applies the stored theme (data-theme on <html>) before React renders;
// index.html already set it pre-paint for the no-flash path.
initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppStateProvider>
          <App />
        </AppStateProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

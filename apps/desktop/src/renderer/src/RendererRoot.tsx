import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { QuickPalette } from "./components/QuickPalette";
import { ToastProvider } from "./lib/toast";
import { AppStateProvider } from "./state/app-state";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function RendererRoot({ hash = window.location.hash }: { hash?: string }) {
  if (hash === "#quick-palette") return <QuickPalette />;
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppStateProvider>
          <App />
        </AppStateProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

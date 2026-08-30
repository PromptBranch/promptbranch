/**
 * Renderer test harness: jsdom polyfills (matchMedia, ResizeObserver,
 * scrollIntoView — used by the theme hook, Radix poppers and the model
 * picker's keyboard nav) plus a `renderApp` wrapper that mounts a component
 * with the same providers as main.tsx (react-query, app state, toasts).
 *
 * Importing this module also registers the jest-dom matchers
 * (toBeInTheDocument, toBeDisabled, …) on vitest's `expect`.
 */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach } from "vitest";
import { AppStateProvider } from "../state/app-state";
import { ToastProvider } from "../lib/toast";

// RTL's auto-cleanup only kicks in when test globals are on; register it
// explicitly so renders don't accumulate in document.body across tests.
afterEach(cleanup);

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

/** Fresh QueryClient per test: no retries, no cache sharing between tests. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function TestProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient ?? createTestQueryClient()}>
      <AppStateProvider>
        <ToastProvider>{children}</ToastProvider>
      </AppStateProvider>
    </QueryClientProvider>
  );
}

/**
 * `render` with the app providers pre-wrapped. Pass `queryClient` to pre-seed
 * the cache (e.g. `client.setQueryData(qk.aiProviders, [...])`) when a test
 * needs query data available synchronously on first render.
 */
export function renderApp(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper"> & { queryClient?: QueryClient },
) {
  const { queryClient, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: ({ children }) => <TestProviders queryClient={queryClient}>{children}</TestProviders>,
    ...renderOptions,
  });
}

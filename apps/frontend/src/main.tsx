import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import "./index.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

if (rootElement === null) {
  throw new Error("Root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

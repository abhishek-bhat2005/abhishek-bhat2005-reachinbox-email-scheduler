import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("application routes", () => {
  it("shows Google login when the session is unauthenticated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required" } },
          401,
        ),
      ),
    );

    renderApp();

    expect(await screen.findByRole("heading", { name: "Sign in to your workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });

  it("renders the authenticated scheduling dashboard", async () => {
    window.history.replaceState({}, "", "/dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url.endsWith("/auth/me")) {
          return jsonResponse({
            user: {
              id: "user-1",
              email: "engineer@example.com",
              name: "Demo Engineer",
              avatarUrl: null,
            },
          });
        }
        if (url.endsWith("/config/compose")) {
          return jsonResponse({
            defaults: { hourlyLimit: 100, minimumDelayMs: 1_000, pageSize: 50 },
            limits: {
              hourlyLimit: { min: 1, max: 10_000 },
              minimumDelayMs: { min: 0, max: 3_600_000 },
              maxBodyLength: 100_000,
              maxLeadsPerBatch: 10_000,
              maxScheduleHorizonDays: 365,
              maxSubjectLength: 998,
              maxUploadBytes: 5_000_000,
            },
          });
        }
        if (url.endsWith("/senders")) return jsonResponse({ senders: [] });
        if (url.endsWith("/emails/scheduled")) {
          return jsonResponse({ items: [], nextCursor: null });
        }
        return jsonResponse({ error: { message: "Unexpected test request" } }, 500);
      }),
    );

    renderApp();

    expect(await screen.findByRole("heading", { name: "Good to see you, Demo" })).toBeTruthy();
    expect(await screen.findByText("No scheduled emails yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compose new email" })).toBeTruthy();
  });
});

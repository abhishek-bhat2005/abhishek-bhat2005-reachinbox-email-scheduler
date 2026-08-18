import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeConfig, Sender } from "../api/types";
import { ComposeModal } from "./ComposeModal";

const config: ComposeConfig = {
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
};
const sender: Sender = {
  id: "4ee12a0e-58cc-4af4-b495-352640e7b3b0",
  displayName: "Demo Sender",
  email: "sender@example.com",
  isDefault: true,
  isActive: true,
  hourlyLimit: 100,
  minimumDelayMs: 1_000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComposeModal", () => {
  it("previews lead quality and submits one validated multipart request", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(
        JSON.stringify({
          replayed: false,
          batch: {
            id: "batch-1",
            status: "scheduled",
            startAt: "2099-01-01T10:00:00.000Z",
            totalRows: 3,
            validRecipientCount: 1,
            invalidRecipientCount: 1,
            duplicateRecipientCount: 1,
            invalidRows: [{ row: 3, value: "bad", reason: "invalid email" }],
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const onScheduled = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ComposeModal
          config={config}
          onClose={() => undefined}
          onScheduled={onScheduled}
          senders={[sender]}
        />
      </QueryClientProvider>,
    );
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    if (fileInput === null) return;

    const file = new File(["email\nfirst@example.com\nbad\nfirst@example.com"], "leads.csv", {
      type: "text/csv",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("1 valid")).toBeTruthy();
    expect(screen.getByText("1 duplicate")).toBeTruthy();
    expect(screen.getByText("1 invalid")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Demo subject" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Demo body" } });
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "2099-01-01T10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule campaign" }));

    await vi.waitFor(() => expect(onScheduled).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

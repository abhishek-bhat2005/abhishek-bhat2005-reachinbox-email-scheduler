import { ChevronLeft, ChevronRight, ExternalLink, Inbox, LoaderCircle } from "lucide-react";

import type { ScheduledEmail, SentEmail } from "../api/types";
import { StatusBadge } from "./StatusBadge";

interface EmailTableProps {
  kind: "scheduled" | "sent";
  items: ScheduledEmail[] | SentEmail[];
  loading: boolean;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

function formatDate(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function EmailTable({
  kind,
  items,
  loading,
  error,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: EmailTableProps) {
  if (loading) {
    return (
      <div className="grid min-h-80 place-items-center rounded-2xl border border-slate-200 bg-white">
        <div className="text-center text-slate-500">
          <LoaderCircle className="mx-auto mb-3 size-7 animate-spin text-indigo-600" />
          Loading emails…
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="grid min-h-80 place-items-center rounded-2xl border border-rose-200 bg-rose-50 px-6 text-center text-rose-700">
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="grid min-h-80 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 text-center">
        <div>
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-500">
            <Inbox className="size-6" />
          </span>
          <h3 className="mt-4 font-semibold text-slate-900">
            No {kind === "scheduled" ? "scheduled" : "sent"} emails yet
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            {kind === "scheduled"
              ? "Compose a campaign to see its recipients here."
              : "Completed deliveries and failures will appear here."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/40">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left">
          <thead className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-6 py-4">Recipient</th>
              <th className="px-6 py-4">Subject</th>
              <th className="px-6 py-4">Sender</th>
              <th className="px-6 py-4">{kind === "scheduled" ? "Scheduled for" : "Completed"}</th>
              <th className="px-6 py-4">Status</th>
              {kind === "sent" && <th className="px-6 py-4 text-right">Preview</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => {
              const sentItem: SentEmail | null = "completedAt" in item ? item : null;
              const scheduledItem: ScheduledEmail | null = "nextAttemptAt" in item ? item : null;
              const date =
                scheduledItem?.nextAttemptAt ?? sentItem?.sentAt ?? sentItem?.completedAt ?? null;
              return (
                <tr key={item.id} className="transition hover:bg-slate-50/70">
                  <td className="px-6 py-4 text-sm font-medium text-slate-900">
                    {item.recipientEmail}
                  </td>
                  <td className="max-w-64 truncate px-6 py-4 text-sm text-slate-600">
                    {item.subject}
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-sm font-medium text-slate-700">{item.sender.displayName}</p>
                    <p className="text-xs text-slate-400">{item.sender.email}</p>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-600">
                    {formatDate(date)}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={item.status} />
                  </td>
                  {kind === "sent" && (
                    <td className="px-6 py-4 text-right">
                      {sentItem?.etherealPreviewUrl === null ? (
                        <span className="text-sm text-slate-400">—</span>
                      ) : (
                        <a
                          className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:text-indigo-800"
                          href={sentItem?.etherealPreviewUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open <ExternalLink className="size-3.5" />
                        </a>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3">
        <p className="text-sm text-slate-500">Showing {items.length} results</p>
        <div className="flex gap-2">
          <button
            className="rounded-lg border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGoBack}
            onClick={onBack}
            type="button"
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            className="rounded-lg border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGoForward}
            onClick={onForward}
            type="button"
            aria-label="Next page"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

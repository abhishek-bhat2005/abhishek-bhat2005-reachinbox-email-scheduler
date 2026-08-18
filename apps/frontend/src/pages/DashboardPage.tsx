import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  LogOut,
  MailCheck,
  Plus,
  RefreshCw,
  Send,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api, ApiError, dashboardRefreshMs } from "../api/client";
import type { ScheduleBatchResponse, ScheduledEmail, SentEmail, User } from "../api/types";
import { ComposeModal } from "../components/ComposeModal";
import { EmailTable } from "../components/EmailTable";
import { UserAvatar } from "../components/UserAvatar";

interface DashboardPageProps {
  user: User;
}

type Tab = "scheduled" | "sent";

export function DashboardPage({ user }: DashboardPageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const activeTab: Tab = params.get("tab") === "sent" ? "sent" : "scheduled";
  const [composeOpen, setComposeOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scheduledCursors, setScheduledCursors] = useState<(string | undefined)[]>([undefined]);
  const [sentCursors, setSentCursors] = useState<(string | undefined)[]>([undefined]);
  const cursors = activeTab === "scheduled" ? scheduledCursors : sentCursors;
  const cursor = cursors.at(-1);

  const configQuery = useQuery({ queryKey: ["compose-config"], queryFn: api.composeConfig });
  const sendersQuery = useQuery({ queryKey: ["senders"], queryFn: api.senders });
  const scheduledQuery = useQuery({
    queryKey: ["emails", "scheduled", cursor],
    queryFn: () => api.scheduled(cursor),
    enabled: activeTab === "scheduled",
    refetchInterval: dashboardRefreshMs,
  });
  const sentQuery = useQuery({
    queryKey: ["emails", "sent", cursor],
    queryFn: () => api.sent(cursor),
    enabled: activeTab === "sent",
    refetchInterval: dashboardRefreshMs,
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      navigate("/login", { replace: true });
    },
  });

  const currentQuery = activeTab === "scheduled" ? scheduledQuery : sentQuery;
  const items: ScheduledEmail[] | SentEmail[] = currentQuery.data?.items ?? [];
  const error =
    currentQuery.error instanceof ApiError
      ? currentQuery.error.message
      : currentQuery.error === null
        ? null
        : "The email list could not be loaded";

  const switchTab = (tab: Tab) => {
    setParams({ tab });
    setToast(null);
  };
  const nextPage = () => {
    const next = currentQuery.data?.nextCursor;
    if (next === null || next === undefined) return;
    if (activeTab === "scheduled") setScheduledCursors((values) => [...values, next]);
    else setSentCursors((values) => [...values, next]);
  };
  const previousPage = () => {
    if (activeTab === "scheduled") setScheduledCursors((values) => values.slice(0, -1));
    else setSentCursors((values) => values.slice(0, -1));
  };
  const scheduled = async (response: ScheduleBatchResponse) => {
    setComposeOpen(false);
    setToast(
      `${response.batch.validRecipientCount.toLocaleString()} email${response.batch.validRecipientCount === 1 ? "" : "s"} scheduled`,
    );
    setParams({ tab: "scheduled" });
    setScheduledCursors([undefined]);
    await queryClient.invalidateQueries({ queryKey: ["emails"] });
  };

  const firstName = user.name.trim().split(/\s+/u)[0] ?? user.name;

  return (
    <main className="min-h-screen bg-[#f6f7fb] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/20">
              <MailCheck className="size-5" />
            </span>
            <div>
              <p className="font-bold tracking-tight">ReachInbox</p>
              <p className="text-xs text-slate-400">Email Scheduler</p>
            </div>
          </div>

          <div className="group relative">
            <button
              className="flex items-center gap-3 rounded-xl p-2 text-left hover:bg-slate-50"
              type="button"
            >
              <UserAvatar avatarUrl={user.avatarUrl} name={user.name} />
              <span className="hidden sm:block">
                <span className="block text-sm font-semibold text-slate-800">{user.name}</span>
                <span className="block max-w-48 truncate text-xs text-slate-400">{user.email}</span>
              </span>
              <ChevronDown className="size-4 text-slate-400" />
            </button>
            <div className="invisible absolute right-0 z-20 w-48 translate-y-1 rounded-xl border border-slate-200 bg-white p-2 opacity-0 shadow-xl transition group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
                type="button"
              >
                <LogOut className="size-4" /> Log out
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-10">
        <section className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-indigo-600">Campaign workspace</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
              Good to see you, {firstName}
            </h1>
            <p className="mt-2 text-slate-500">
              Schedule reliable outreach and follow every delivery.
            </p>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:-translate-y-0.5 hover:bg-indigo-700 disabled:opacity-50"
            disabled={
              !configQuery.data || !sendersQuery.data || sendersQuery.data.senders.length === 0
            }
            onClick={() => setComposeOpen(true)}
            type="button"
          >
            <Plus className="size-4" /> Compose new email
          </button>
        </section>

        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          <div className="metric-card">
            <span className="metric-icon bg-blue-50 text-blue-600">
              <CalendarClock />
            </span>
            <div>
              <p className="metric-label">On this page</p>
              <p className="metric-value">{items.length}</p>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon bg-emerald-50 text-emerald-600">
              <CheckCircle2 />
            </span>
            <div>
              <p className="metric-label">Active senders</p>
              <p className="metric-value">
                {sendersQuery.data?.senders.filter((sender) => sender.isActive).length ?? "—"}
              </p>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon bg-violet-50 text-violet-600">
              <Send />
            </span>
            <div>
              <p className="metric-label">Auto refresh</p>
              <p className="metric-value text-lg">Live</p>
            </div>
          </div>
        </section>

        {toast !== null && (
          <div
            className="mt-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800"
            role="status"
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="size-4" /> {toast}
            </span>
            <button aria-label="Dismiss notification" onClick={() => setToast(null)} type="button">
              ×
            </button>
          </div>
        )}

        <section className="mt-8">
          <div className="mb-5 flex flex-col gap-4 border-b border-slate-200 sm:flex-row sm:items-center sm:justify-between">
            <nav aria-label="Email status" className="flex gap-6">
              {(["scheduled", "sent"] as const).map((tab) => (
                <button
                  className={`relative pb-4 text-sm font-semibold capitalize transition ${activeTab === tab ? "text-indigo-600" : "text-slate-500 hover:text-slate-800"}`}
                  key={tab}
                  onClick={() => switchTab(tab)}
                  type="button"
                >
                  {tab} emails
                  {activeTab === tab && (
                    <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-indigo-600" />
                  )}
                </button>
              ))}
            </nav>
            <button
              className="mb-3 inline-flex items-center gap-2 self-start text-sm font-semibold text-slate-500 hover:text-indigo-600 sm:self-auto"
              onClick={() => void currentQuery.refetch()}
              type="button"
            >
              <RefreshCw className={`size-4 ${currentQuery.isFetching ? "animate-spin" : ""}`} />{" "}
              Refresh
            </button>
          </div>

          <EmailTable
            canGoBack={cursors.length > 1}
            canGoForward={
              currentQuery.data?.nextCursor !== null && currentQuery.data?.nextCursor !== undefined
            }
            error={error}
            items={items}
            kind={activeTab}
            loading={currentQuery.isLoading}
            onBack={previousPage}
            onForward={nextPage}
          />
        </section>
      </div>

      {composeOpen && configQuery.data && sendersQuery.data && (
        <ComposeModal
          config={configQuery.data}
          onClose={() => setComposeOpen(false)}
          onScheduled={(response) => void scheduled(response)}
          senders={sendersQuery.data.senders.filter((sender) => sender.isActive)}
        />
      )}
    </main>
  );
}

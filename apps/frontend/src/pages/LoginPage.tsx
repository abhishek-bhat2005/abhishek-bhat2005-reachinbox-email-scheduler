import { ArrowRight, CalendarClock, Gauge, MailCheck } from "lucide-react";
import { Navigate } from "react-router-dom";

import { googleLoginUrl } from "../api/client";
import type { User } from "../api/types";

const features = [
  { Icon: CalendarClock, label: "Durable scheduling" },
  { Icon: Gauge, label: "Atomic rate limits" },
  { Icon: MailCheck, label: "Ethereal previews" },
] as const;

interface LoginPageProps {
  user: User | null;
}

export function LoginPage({ user }: LoginPageProps) {
  if (user !== null) return <Navigate replace to="/dashboard" />;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f5f7fb] px-5 py-8 sm:px-8">
      <div className="pointer-events-none absolute -left-36 top-16 size-96 rounded-full bg-indigo-200/50 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-0 size-96 rounded-full bg-violet-200/50 blur-3xl" />

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl overflow-hidden rounded-[2rem] border border-white/70 bg-white shadow-2xl shadow-slate-300/50">
        <section className="hidden w-[52%] flex-col justify-between bg-slate-950 p-12 text-white lg:flex">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-indigo-500">
              <MailCheck className="size-5" />
            </span>
            <span className="text-lg font-bold tracking-tight">ReachInbox Scheduler</span>
          </div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-indigo-300">
              Deliver with confidence
            </p>
            <h1 className="mt-5 max-w-xl text-5xl font-bold leading-[1.08] tracking-tight">
              Schedule outreach that keeps its promises.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-8 text-slate-300">
              Durable delayed jobs, sender-aware limits, and a clear view of every scheduled and
              completed email.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            {features.map(({ Icon, label }) => (
              <div key={label} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <Icon className="mb-3 size-5 text-indigo-300" />
                <span className="font-medium text-slate-200">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-1 items-center justify-center px-6 py-16 sm:px-14">
          <div className="w-full max-w-md">
            <div className="flex items-center gap-3 lg:hidden">
              <span className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white">
                <MailCheck className="size-5" />
              </span>
              <span className="font-bold">ReachInbox Scheduler</span>
            </div>
            <p className="mt-12 text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600 lg:mt-0">
              Welcome back
            </p>
            <h2 className="mt-3 text-4xl font-bold tracking-tight text-slate-950">
              Sign in to your workspace
            </h2>
            <p className="mt-4 leading-7 text-slate-500">
              Use your Google account to securely access campaigns, senders, and delivery history.
            </p>
            <button
              className="mt-9 flex w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 font-semibold text-slate-800 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
              onClick={() => window.location.assign(googleLoginUrl())}
              type="button"
            >
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full bg-white text-lg font-bold text-blue-600 shadow ring-1 ring-slate-200"
              >
                G
              </span>
              Continue with Google
              <ArrowRight className="ml-auto size-4 text-slate-400" />
            </button>
            <p className="mt-6 text-center text-xs leading-5 text-slate-400">
              Authentication is handled by Google. This application never receives your Google
              password.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

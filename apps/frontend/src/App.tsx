import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { api, ApiError } from "./api/client";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";

function AppRoutes() {
  const auth = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.currentUser,
    retry: false,
    staleTime: 60_000,
  });

  if (auth.isLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 text-slate-500">
        <div className="text-center">
          <LoaderCircle className="mx-auto mb-3 size-7 animate-spin text-indigo-600" />
          Restoring your workspace…
        </div>
      </main>
    );
  }

  const unauthenticated = auth.error instanceof ApiError && auth.error.status === 401;
  if (auth.isError && !unauthenticated) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 px-5 text-center">
        <div>
          <h1 className="text-xl font-bold text-slate-900">The workspace is unavailable</h1>
          <p className="mt-2 text-slate-500">
            Check that the backend, PostgreSQL, and Redis are running.
          </p>
          <button
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white"
            onClick={() => void auth.refetch()}
            type="button"
          >
            <RefreshCw className="size-4" /> Try again
          </button>
        </div>
      </main>
    );
  }

  const user = auth.data?.user ?? null;

  return (
    <Routes>
      <Route element={<LoginPage user={user} />} path="/login" />
      <Route
        element={user === null ? <Navigate replace to="/login" /> : <DashboardPage user={user} />}
        path="/dashboard"
      />
      <Route element={<Navigate replace to={user === null ? "/login" : "/dashboard"} />} path="*" />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

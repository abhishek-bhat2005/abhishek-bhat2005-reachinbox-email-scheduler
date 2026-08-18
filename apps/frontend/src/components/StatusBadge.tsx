interface StatusBadgeProps {
  status: string;
}

const tones: Record<string, string> = {
  scheduled: "bg-blue-50 text-blue-700 ring-blue-600/20",
  rate_limited: "bg-amber-50 text-amber-700 ring-amber-600/20",
  processing: "bg-violet-50 text-violet-700 ring-violet-600/20",
  retryable: "bg-orange-50 text-orange-700 ring-orange-600/20",
  sent: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20",
  delivery_unknown: "bg-slate-100 text-slate-700 ring-slate-600/20",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = status.replaceAll("_", " ");
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1 ring-inset ${tones[status] ?? tones.delivery_unknown}`}
    >
      {label}
    </span>
  );
}

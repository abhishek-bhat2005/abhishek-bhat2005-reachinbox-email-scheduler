import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { FileText, LoaderCircle, UploadCloud, X } from "lucide-react";
import Papa from "papaparse";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { api, ApiError } from "../api/client";
import type { ComposeConfig, ScheduleBatchResponse, Sender } from "../api/types";

interface ComposeModalProps {
  config: ComposeConfig;
  senders: Sender[];
  onClose: () => void;
  onScheduled: (response: ScheduleBatchResponse) => void;
}

interface LeadPreview {
  detected: number;
  valid: number;
  invalid: number;
  duplicate: number;
}

function previewLeadFile(file: File, maxLeads: number): Promise<LeadPreview> {
  return file.text().then((text) => {
    let values: string[];
    if (file.name.toLowerCase().endsWith(".csv")) {
      const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
      const fatalErrors = result.errors.filter((error) => error.code !== "UndetectableDelimiter");
      if (fatalErrors.length > 0) throw new Error("The CSV preview could not be parsed");
      const rows = result.data;
      const first = rows[0] ?? [];
      const emailColumn = first.findIndex((value) => value.trim().toLowerCase() === "email");
      const start = emailColumn >= 0 ? 1 : 0;
      const column = emailColumn >= 0 ? emailColumn : 0;
      if (emailColumn < 0 && rows.some((row) => row.length !== 1)) {
        throw new Error("A multi-column CSV needs an email header");
      }
      values = rows.slice(start).map((row) => row[column] ?? "");
    } else {
      values = text
        .split(/\r?\n/u)
        .flatMap((line) => line.split(","))
        .filter((value) => value.trim().length > 0);
    }

    if (values.length > maxLeads) {
      throw new Error(`The file exceeds the ${maxLeads.toLocaleString()} lead limit`);
    }

    const seen = new Set<string>();
    let valid = 0;
    let invalid = 0;
    let duplicate = 0;
    for (const value of values) {
      const email = value.trim();
      if (!z.email().max(320).safeParse(email).success) {
        invalid += 1;
      } else if (seen.has(email.toLowerCase())) {
        duplicate += 1;
      } else {
        seen.add(email.toLowerCase());
        valid += 1;
      }
    }
    return { detected: values.length, valid, invalid, duplicate };
  });
}

export function ComposeModal({ config, senders, onClose, onScheduled }: ComposeModalProps) {
  const schema = useMemo(
    () =>
      z.object({
        senderId: z.uuid("Choose a sender"),
        subject: z
          .string()
          .trim()
          .min(1, "Subject is required")
          .max(config.limits.maxSubjectLength),
        body: z.string().min(1, "Message body is required").max(config.limits.maxBodyLength),
        startAt: z.string().min(1, "Start time is required"),
        minimumDelayMs: z
          .number()
          .int()
          .min(config.limits.minimumDelayMs.min)
          .max(config.limits.minimumDelayMs.max),
        hourlyLimit: z
          .number()
          .int()
          .min(config.limits.hourlyLimit.min)
          .max(config.limits.hourlyLimit.max),
      }),
    [config],
  );
  type ComposeForm = z.infer<typeof schema>;
  const defaultSender = senders.find((sender) => sender.isDefault) ?? senders[0];
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LeadPreview | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ComposeForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      senderId: defaultSender?.id ?? "",
      subject: "",
      body: "",
      startAt: "",
      minimumDelayMs: config.defaults.minimumDelayMs,
      hourlyLimit: config.defaults.hourlyLimit,
    },
  });
  const schedule = useMutation({
    mutationFn: ({ values, leadsFile }: { values: ComposeForm; leadsFile: File }) => {
      const formData = new FormData();
      formData.append("senderId", values.senderId);
      formData.append("subject", values.subject);
      formData.append("body", values.body);
      formData.append("startAt", new Date(values.startAt).toISOString());
      formData.append("minimumDelayMs", String(values.minimumDelayMs));
      formData.append("hourlyLimit", String(values.hourlyLimit));
      formData.append("leadsFile", leadsFile);
      return api.scheduleBatch(formData, idempotencyKey.current);
    },
    onSuccess: onScheduled,
  });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !schedule.isPending) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, schedule.isPending]);

  const selectFile = async (selected: File | undefined) => {
    setFileError(null);
    setPreview(null);
    setFile(null);
    if (selected === undefined) return;
    const extension = selected.name.toLowerCase().split(".").at(-1);
    if (extension !== "csv" && extension !== "txt") {
      setFileError("Choose a .csv or .txt file");
      return;
    }
    if (selected.size > config.limits.maxUploadBytes) {
      setFileError("The file is larger than the configured upload limit");
      return;
    }
    try {
      const result = await previewLeadFile(selected, config.limits.maxLeadsPerBatch);
      if (result.valid === 0) throw new Error("No valid email addresses were found");
      setFile(selected);
      setPreview(result);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "The file could not be read");
    }
  };

  const submit = handleSubmit((values) => {
    if (file === null || preview === null) {
      setFileError("Upload a lead file before scheduling");
      return;
    }
    schedule.mutate({ values, leadsFile: file });
  });
  const requestError =
    schedule.error instanceof ApiError
      ? schedule.error.message
      : schedule.error === null
        ? null
        : "The campaign could not be scheduled";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !schedule.isPending) onClose();
      }}
    >
      <section
        aria-labelledby="compose-title"
        aria-modal="true"
        className="max-h-[95vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
        role="dialog"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-6 py-5 backdrop-blur sm:px-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">
              Campaign
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-950" id="compose-title">
              Compose new email
            </h2>
          </div>
          <button
            aria-label="Close compose dialog"
            className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"
            disabled={schedule.isPending}
            onClick={onClose}
            type="button"
          >
            <X className="size-5" />
          </button>
        </header>

        <form className="space-y-6 px-6 py-6 sm:px-8" onSubmit={submit}>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-semibold text-slate-700 sm:col-span-2">
              Sender
              <select className="field" {...register("senderId")}>
                {senders.map((sender) => (
                  <option key={sender.id} value={sender.id}>
                    {sender.displayName} · {sender.email}
                  </option>
                ))}
              </select>
              {errors.senderId && <span className="field-error">{errors.senderId.message}</span>}
            </label>

            <label className="space-y-2 text-sm font-semibold text-slate-700 sm:col-span-2">
              Subject
              <input
                className="field"
                placeholder="Quarterly product update"
                {...register("subject")}
              />
              {errors.subject && <span className="field-error">{errors.subject.message}</span>}
            </label>

            <label className="space-y-2 text-sm font-semibold text-slate-700 sm:col-span-2">
              Message
              <textarea
                className="field min-h-36 resize-y"
                placeholder="Write a plain-text message…"
                {...register("body")}
              />
              {errors.body && <span className="field-error">{errors.body.message}</span>}
            </label>

            <label className="space-y-2 text-sm font-semibold text-slate-700">
              Start time
              <input className="field" type="datetime-local" {...register("startAt")} />
              {errors.startAt && <span className="field-error">{errors.startAt.message}</span>}
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-2 text-sm font-semibold text-slate-700">
                Delay (ms)
                <input
                  className="field"
                  type="number"
                  {...register("minimumDelayMs", { valueAsNumber: true })}
                />
                {errors.minimumDelayMs && (
                  <span className="field-error">{errors.minimumDelayMs.message}</span>
                )}
              </label>
              <label className="space-y-2 text-sm font-semibold text-slate-700">
                Hourly limit
                <input
                  className="field"
                  type="number"
                  {...register("hourlyLimit", { valueAsNumber: true })}
                />
                {errors.hourlyLimit && (
                  <span className="field-error">{errors.hourlyLimit.message}</span>
                )}
              </label>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-slate-700">Lead file</p>
            <label className="flex cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center transition hover:border-indigo-400 hover:bg-indigo-50/40">
              <input
                accept=".csv,.txt,text/csv,text/plain"
                className="sr-only"
                onChange={(event) => void selectFile(event.target.files?.[0])}
                type="file"
              />
              <span>
                <UploadCloud className="mx-auto size-7 text-indigo-600" />
                <span className="mt-2 block text-sm font-semibold text-slate-800">
                  Upload CSV or text leads
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  Up to {config.limits.maxLeadsPerBatch.toLocaleString()} rows
                </span>
              </span>
            </label>
            {file !== null && preview !== null && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <FileText className="size-5" />
                <span className="font-semibold">{file.name}</span>
                <span>{preview.valid} valid</span>
                <span>{preview.duplicate} duplicate</span>
                <span>{preview.invalid} invalid</span>
              </div>
            )}
            {fileError !== null && <p className="field-error mt-2">{fileError}</p>}
          </div>

          {requestError !== null && (
            <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">
              {requestError}
            </p>
          )}

          <footer className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
            <button
              className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              disabled={schedule.isPending}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
              disabled={schedule.isPending || senders.length === 0}
              type="submit"
            >
              {schedule.isPending && <LoaderCircle className="size-4 animate-spin" />}
              Schedule campaign
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

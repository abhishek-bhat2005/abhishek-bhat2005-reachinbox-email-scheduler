import type { AppConfig } from "../config/env.js";

type LogLevel = AppConfig["LOG_LEVEL"];
type EmittedLogLevel = Exclude<LogLevel, "silent">;
type LogValue = boolean | number | string | null | undefined;
export type LogContext = Record<string, LogValue>;

const priorities: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 70,
};
const sensitiveKey = /authorization|body|cookie|credential|password|secret|token/iu;

function safeContext(context: LogContext): Record<string, boolean | number | string | null> {
  return Object.fromEntries(
    Object.entries(context)
      .filter((entry): entry is [string, Exclude<LogValue, undefined>] => entry[1] !== undefined)
      .map(([key, value]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : value]),
  );
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export interface Logger {
  trace: (message: string, context?: LogContext) => void;
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  fatal: (message: string, context?: LogContext) => void;
}

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">, component: string): Logger {
  const emit = (level: EmittedLogLevel, message: string, context: LogContext = {}): void => {
    if (priorities[level] < priorities[config.LOG_LEVEL]) return;

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...safeContext(context),
    });
    if (level === "fatal" || level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  };

  return {
    trace: (message, context) => emit("trace", message, context),
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    fatal: (message, context) => emit("fatal", message, context),
  };
}

import { config } from "./config.js";

type Level = "error" | "warn" | "info" | "debug";

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = ORDER[config.logLevel];

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (ORDER[level] > threshold) return;
  const time = new Date().toISOString();
  const tail = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};

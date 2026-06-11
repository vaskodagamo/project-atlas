import { config as loadEnv } from "dotenv";
import { z } from "zod";

// `.env` is the source of truth for this service — override any stale shell exports (e.g. an old
// OPENAI_API_KEY in ~/.zshrc) so the wrong variable can't silently shadow the file.
loadEnv({ override: true });

/** The Realtime API speaks 24 kHz mono PCM16 in both directions. Fixed by the API. */
export const REALTIME_SAMPLE_RATE = 24000;

const schema = z.object({
  // OpenAI Realtime (the brain)
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  JARVIS_VOICE: z.string().default("marin"),

  // Wake mechanism: push-to-talk (no account) or the Porcupine "Hey Jarvis" wake word.
  WAKE_MODE: z.enum(["ptt", "porcupine"]).default("ptt"),
  // Picovoice Porcupine — only required when WAKE_MODE=porcupine (validated in index.ts).
  PICOVOICE_ACCESS_KEY: z.string().default(""),
  WAKE_SENSITIVITY: z.coerce.number().min(0).max(1).default(0.5),

  // OpenClaw backbone — the bridge shells out to the `openclaw agent` CLI, which drives the gateway.
  OPENCLAW_URL: z.string().url().default("http://127.0.0.1:18789"),
  OPENCLAW_BIN: z.string().default("openclaw"),
  OPENCLAW_AGENT: z.string().default("main"),
  OPENCLAW_THINKING: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"])
    .default("off"),

  // Work email over IMAP (optional — email tools only load when host/user/password are all set).
  IMAP_HOST: z.string().default(""),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().default(""),
  IMAP_PASSWORD: z.string().default(""),
  IMAP_TLS: z.string().default("true").transform((v) => v !== "false"),
  IMAP_DRAFTS_FOLDER: z.string().default("Drafts"),
  EMAIL_FROM: z.string().default(""),

  // EMEET audio (capture device; playback uses the system default output via ffplay)
  EMEET_DEVICE_NAME: z.string().default("EMEET"),
  CAPTURE_SAMPLE_RATE: z.coerce.number().int().positive().default(16000),

  // Behaviour
  SESSION_INACTIVITY_MS: z.coerce.number().int().positive().default(30000),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`Invalid configuration. Check your .env file:\n${issues}`);
    process.exit(1);
  }
  const e = parsed.data;
  return {
    openai: {
      apiKey: e.OPENAI_API_KEY,
      model: e.OPENAI_REALTIME_MODEL,
      voice: e.JARVIS_VOICE,
    },
    wake: { mode: e.WAKE_MODE },
    picovoice: {
      accessKey: e.PICOVOICE_ACCESS_KEY,
      sensitivity: e.WAKE_SENSITIVITY,
    },
    openclaw: {
      url: e.OPENCLAW_URL.replace(/\/$/, ""),
      bin: e.OPENCLAW_BIN,
      agent: e.OPENCLAW_AGENT,
      thinking: e.OPENCLAW_THINKING,
    },
    email: {
      enabled: Boolean(e.IMAP_HOST && e.IMAP_USER && e.IMAP_PASSWORD),
      host: e.IMAP_HOST,
      port: e.IMAP_PORT,
      user: e.IMAP_USER,
      password: e.IMAP_PASSWORD,
      tls: e.IMAP_TLS,
      draftsFolder: e.IMAP_DRAFTS_FOLDER,
      from: e.EMAIL_FROM || e.IMAP_USER,
    },
    audio: {
      deviceName: e.EMEET_DEVICE_NAME,
      captureSampleRate: e.CAPTURE_SAMPLE_RATE,
    },
    session: { inactivityMs: e.SESSION_INACTIVITY_MS },
    logLevel: e.LOG_LEVEL,
  };
}

export type Config = ReturnType<typeof load>;
export const config = load();

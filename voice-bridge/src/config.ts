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

  // Email account 1 — generic IMAP (e.g. work). Tools load when host/user/password are all set.
  IMAP_LABEL: z.string().default("work"),
  IMAP_HOST: z.string().default(""),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().default(""),
  IMAP_PASSWORD: z.string().default(""),
  IMAP_TLS: z.string().default("true").transform((v) => v !== "false"),
  IMAP_DRAFTS_FOLDER: z.string().default("Drafts"),
  EMAIL_FROM: z.string().default(""),

  // Email account 2 — Gmail via app password (host/port/Drafts are preset for Gmail).
  GMAIL_LABEL: z.string().default("personal"),
  GMAIL_USER: z.string().default(""),
  // Gmail shows the app password in 4 space-separated groups; the real value has no spaces.
  GMAIL_APP_PASSWORD: z.string().default("").transform((v) => v.replace(/\s+/g, "")),
  GMAIL_DRAFTS_FOLDER: z.string().default("[Gmail]/Drafts"),

  // Mac control (open apps, volume, AppleScript, shell). Powerful run_shell/run_applescript are
  // gated behind a spoken confirmation. Set to false to disable all Mac control tools.
  MAC_CONTROL: z.string().default("true").transform((v) => v !== "false"),

  // WhatsApp via Baileys (unofficial multi-device client — opt-in). First run shows a QR to link.
  WHATSAPP_ENABLED: z.string().default("false").transform((v) => v === "true"),

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

  // Build the list of configured email accounts (generic IMAP + Gmail).
  const emailAccounts: Array<{
    label: string;
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
    draftsFolder: string;
    from: string;
  }> = [];
  if (e.IMAP_HOST && e.IMAP_USER && e.IMAP_PASSWORD) {
    emailAccounts.push({
      label: e.IMAP_LABEL,
      host: e.IMAP_HOST,
      port: e.IMAP_PORT,
      user: e.IMAP_USER,
      password: e.IMAP_PASSWORD,
      tls: e.IMAP_TLS,
      draftsFolder: e.IMAP_DRAFTS_FOLDER,
      from: e.EMAIL_FROM || e.IMAP_USER,
    });
  }
  if (e.GMAIL_USER && e.GMAIL_APP_PASSWORD) {
    emailAccounts.push({
      label: e.GMAIL_LABEL,
      host: "imap.gmail.com",
      port: 993,
      user: e.GMAIL_USER,
      password: e.GMAIL_APP_PASSWORD,
      tls: true,
      draftsFolder: e.GMAIL_DRAFTS_FOLDER,
      from: e.GMAIL_USER,
    });
  }

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
    email: { enabled: emailAccounts.length > 0, accounts: emailAccounts },
    mac: { enabled: e.MAC_CONTROL },
    whatsapp: { enabled: e.WHATSAPP_ENABLED },
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

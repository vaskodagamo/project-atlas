import { config } from "../config.js";
import { log } from "../logger.js";
import { askOpenclaw } from "./openclaw.js";
import { listEmails, readEmail, draftEmail, type MailAccount } from "./email.js";
import { openApp, setVolume, macSystem, runAppleScript, runShell } from "./mac.js";

/** JSON-Schema-ish parameter spec passed to the Realtime API. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Reserved for later: destructive tools (send email, run shell, change Home Assistant state, etc.)
   * should set this true and be gated behind a spoken confirmation before the handler runs. No v1
   * tool needs it, but the field exists so confirmation isn't bolted on later.
   */
  requiresConfirmation: boolean;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const tools: ToolDefinition[] = [
  {
    name: "ask_openclaw",
    description:
      "Ask the user's OpenClaw agent to remember a fact, recall stored knowledge, or run a task. " +
      "Use whenever the user says to remember/recall something or asks for anything needing stored " +
      "memory or automation. The prompt is a clear natural-language instruction.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The natural-language instruction for OpenClaw, e.g. 'Remember my office is room 204.'",
        },
      },
      required: ["prompt"],
    },
    requiresConfirmation: false,
    handler: async (args) => {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!prompt.trim()) return "No instruction was provided.";
      return askOpenclaw(prompt);
    },
  },
];

// Email tools load when at least one account (IMAP and/or Gmail) is configured. Read + draft only.
const emailAccounts = config.email.accounts as MailAccount[];
const accountLabels = emailAccounts.map((a) => a.label);

/** Resolve an account label the model passed to a configured account (defaults to the first). */
function resolveAccount(label?: unknown): MailAccount | undefined {
  if (emailAccounts.length === 0) return undefined;
  if (typeof label === "string" && label.trim()) {
    const want = label.trim().toLowerCase();
    const exact = emailAccounts.find((a) => a.label.toLowerCase() === want);
    if (exact) return exact;
    const fuzzy = emailAccounts.find(
      (a) => a.label.toLowerCase().includes(want) || want.includes(a.label.toLowerCase()),
    );
    if (fuzzy) return fuzzy;
  }
  return emailAccounts[0];
}

if (config.email.enabled) {
  const accountProp = {
    type: "string",
    enum: accountLabels,
    description: `Which email account: ${accountLabels.join(" or ")}. Defaults to ${accountLabels[0]} if omitted.`,
  };
  tools.push(
    {
      name: "email_list",
      description:
        `List recent emails (subjects + senders) from one of the user's accounts (${accountLabels.join(", ")}). ` +
        "Set unreadOnly for unread only. Returns a numbered list with a uid for each, for email_read.",
      parameters: {
        type: "object",
        properties: {
          account: accountProp,
          unreadOnly: { type: "boolean", description: "Only unread messages." },
          limit: { type: "number", description: "How many to list (1-25, default 10)." },
        },
      },
      requiresConfirmation: false,
      handler: (args) => {
        const acc = resolveAccount(args.account);
        if (!acc) return Promise.resolve("No email account is configured.");
        return listEmails(acc, {
          unreadOnly: Boolean(args.unreadOnly),
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
      },
    },
    {
      name: "email_read",
      description: "Read one email in full by its uid (from email_list), on the same account.",
      parameters: {
        type: "object",
        properties: {
          account: accountProp,
          uid: { type: "number", description: "The message uid from email_list." },
        },
        required: ["uid"],
      },
      requiresConfirmation: false,
      handler: (args) => {
        const acc = resolveAccount(args.account);
        if (!acc) return Promise.resolve("No email account is configured.");
        return readEmail(acc, { uid: Number(args.uid) });
      },
    },
    {
      name: "email_draft",
      description:
        "Save a DRAFT email to the chosen account's Drafts folder. Never sends — only saves a draft for " +
        "the user to review and send themselves.",
      parameters: {
        type: "object",
        properties: {
          account: accountProp,
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Subject line." },
          body: { type: "string", description: "Plain-text body." },
        },
        required: ["to", "body"],
      },
      requiresConfirmation: false, // saving a draft is non-destructive; sending is not supported
      handler: (args) => {
        const acc = resolveAccount(args.account);
        if (!acc) return Promise.resolve("No email account is configured.");
        return draftEmail(acc, {
          to: String(args.to ?? ""),
          subject: String(args.subject ?? ""),
          body: String(args.body ?? ""),
        });
      },
    },
  );
}

// Mac control tools. The safe ones run instantly; run_shell/run_applescript stage and wait for a
// spoken confirmation (see the gate in dispatch). confirm_action/cancel_action drive that flow.
if (config.mac.enabled) {
  tools.push(
    {
      name: "open_app",
      description: "Open or focus a macOS application by name, e.g. Safari, Mail, Notes.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Application name." } },
        required: ["name"],
      },
      requiresConfirmation: false,
      handler: (args) => openApp(String(args.name ?? "")),
    },
    {
      name: "set_volume",
      description: "Set the Mac output volume to a percentage (0-100).",
      parameters: {
        type: "object",
        properties: { percent: { type: "number", description: "0-100." } },
        required: ["percent"],
      },
      requiresConfirmation: false,
      handler: (args) => setVolume(Number(args.percent)),
    },
    {
      name: "mac_system",
      description:
        "Quick Mac system actions. action is one of: mute, unmute, volume_up, volume_down, " +
        "sleep_display, lock, frontmost_app, running_apps.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["mute", "unmute", "volume_up", "volume_down", "sleep_display", "lock", "frontmost_app", "running_apps"],
          },
        },
        required: ["action"],
      },
      requiresConfirmation: false,
      handler: (args) => macSystem(String(args.action ?? "")),
    },
    {
      name: "run_applescript",
      description: "Run arbitrary AppleScript on the Mac. Powerful — requires the user's spoken confirmation.",
      parameters: {
        type: "object",
        properties: { script: { type: "string", description: "The AppleScript source." } },
        required: ["script"],
      },
      requiresConfirmation: true,
      handler: (args) => runAppleScript(String(args.script ?? "")),
    },
    {
      name: "run_shell",
      description:
        "Run a shell command on the Mac and return its output. Powerful — requires the user's spoken confirmation.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command line." } },
        required: ["command"],
      },
      requiresConfirmation: true,
      handler: (args) => runShell(String(args.command ?? "")),
    },
    {
      name: "confirm_action",
      description: "Confirm and run the action that is awaiting confirmation. Only call after the user clearly agrees.",
      parameters: { type: "object", properties: {} },
      requiresConfirmation: false,
      handler: async () => "ok", // intercepted in dispatch()
    },
    {
      name: "cancel_action",
      description: "Cancel the action that is awaiting confirmation.",
      parameters: { type: "object", properties: {} },
      requiresConfirmation: false,
      handler: async () => "ok", // intercepted in dispatch()
    },
  );
}

const byName = new Map(tools.map((t) => [t.name, t]));

export function getToolDefinitions(): ToolDefinition[] {
  return tools;
}

// A staged, confirmation-gated action. The destructive tool never runs on its own call — it stages
// here, and only confirm_action executes it. Expires after 2 minutes so a stale stage can't fire later.
let pending: { run: () => Promise<string>; description: string; at: number } | null = null;
const CONFIRM_TTL_MS = 120_000;

function describeAction(name: string, args: Record<string, unknown>): string {
  if (name === "run_shell") return `run the shell command: ${String(args.command ?? "")}`;
  if (name === "run_applescript") return "run an AppleScript on your Mac";
  return `run ${name}`;
}

async function safeRun(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  try {
    return await tool.handler(args);
  } catch (err) {
    log.error("tool handler threw", { name: tool.name, err: String(err) });
    return "That tool failed to run.";
  }
}

/** Run a tool call by name. Always resolves to a string for the model to speak. */
export async function dispatch(name: string, rawArgs: string): Promise<string> {
  // Confirmation flow first.
  if (name === "confirm_action") {
    if (!pending || Date.now() - pending.at > CONFIRM_TTL_MS) {
      pending = null;
      return "There's nothing waiting to be confirmed.";
    }
    const p = pending;
    pending = null;
    log.info("action confirmed", { description: p.description });
    return p.run();
  }
  if (name === "cancel_action") {
    const had = pending !== null;
    pending = null;
    return had ? "Okay, cancelled — I won't do that." : "There's nothing to cancel.";
  }

  const tool = byName.get(name);
  if (!tool) {
    log.warn("unknown tool call", { name });
    return `Unknown tool: ${name}.`;
  }

  let args: Record<string, unknown> = {};
  if (rawArgs && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      log.warn("could not parse tool arguments", { name, rawArgs });
      return "The tool arguments were malformed.";
    }
  }

  if (tool.requiresConfirmation) {
    const description = describeAction(name, args);
    pending = { run: () => safeRun(tool, args), description, at: Date.now() };
    log.info("awaiting confirmation", { name, description });
    return `CONFIRMATION REQUIRED — I'm about to ${description}. Tell the user exactly that and ask them to say "confirm" to proceed or "cancel". Do not repeat this tool; wait for their answer, then call confirm_action or cancel_action.`;
  }

  return safeRun(tool, args);
}

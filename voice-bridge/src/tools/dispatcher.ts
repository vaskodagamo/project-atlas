import { config } from "../config.js";
import { log } from "../logger.js";
import { askOpenclaw } from "./openclaw.js";
import { listEmails, readEmail, draftEmail } from "./email.js";

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

// Email tools load only when IMAP is configured (read + draft; nothing is ever sent).
if (config.email.enabled) {
  tools.push(
    {
      name: "email_list",
      description:
        "List the user's recent work emails (subjects + senders). Set unreadOnly to focus on unread. " +
        "Returns a numbered list with a uid for each, for use with email_read.",
      parameters: {
        type: "object",
        properties: {
          unreadOnly: { type: "boolean", description: "Only unread messages." },
          limit: { type: "number", description: "How many to list (1-25, default 10)." },
        },
      },
      requiresConfirmation: false,
      handler: (args) =>
        listEmails({ unreadOnly: Boolean(args.unreadOnly), limit: typeof args.limit === "number" ? args.limit : undefined }),
    },
    {
      name: "email_read",
      description: "Read one work email in full by its uid (from email_list).",
      parameters: {
        type: "object",
        properties: { uid: { type: "number", description: "The message uid from email_list." } },
        required: ["uid"],
      },
      requiresConfirmation: false,
      handler: (args) => readEmail({ uid: Number(args.uid) }),
    },
    {
      name: "email_draft",
      description:
        "Save a DRAFT work email to the Drafts folder. This never sends — it only saves a draft for the " +
        "user to review and send themselves.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Subject line." },
          body: { type: "string", description: "Plain-text body." },
        },
        required: ["to", "body"],
      },
      requiresConfirmation: false, // saving a draft is non-destructive; sending is not supported
      handler: (args) =>
        draftEmail({
          to: String(args.to ?? ""),
          subject: String(args.subject ?? ""),
          body: String(args.body ?? ""),
        }),
    },
  );
}

const byName = new Map(tools.map((t) => [t.name, t]));

export function getToolDefinitions(): ToolDefinition[] {
  return tools;
}

/** Run a tool call by name. Always resolves to a string for the model to speak. */
export async function dispatch(name: string, rawArgs: string): Promise<string> {
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
  // (Future) if (tool.requiresConfirmation && !confirmed) -> request spoken confirmation here.
  try {
    return await tool.handler(args);
  } catch (err) {
    log.error("tool handler threw", { name, err: String(err) });
    return "That tool failed to run.";
  }
}

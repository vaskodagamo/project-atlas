import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config.js";
import { log } from "../logger.js";

// Work email over IMAP: read + draft only (no SMTP, nothing is ever sent). A "draft" is appended to
// the server's Drafts folder. We connect per call and log out — simple and stateless; IMAP connect
// is ~1s which is fine for voice. All functions return a short, speakable string for the model.

function clientOptions(): ImapFlowOptions {
  return {
    host: config.email.host,
    port: config.email.port,
    secure: config.email.tls,
    auth: { user: config.email.user, pass: config.email.password },
    logger: false, // silence imapflow's own pino logging
  };
}

async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow(clientOptions());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function formatAddress(addr?: { name?: string; address?: string } | null): string {
  if (!addr) return "unknown sender";
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address || addr.name || "unknown sender";
}

function shortDate(d?: Date | string | null): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** List recent (optionally unread) messages from a mailbox. */
export async function listEmails(opts: {
  unreadOnly?: boolean;
  limit?: number;
  mailbox?: string;
}): Promise<string> {
  const mailbox = opts.mailbox || "INBOX";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  try {
    return await withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = await client.search(opts.unreadOnly ? { seen: false } : { all: true }, { uid: true });
        if (!uids || uids.length === 0) {
          return opts.unreadOnly ? `No unread messages in ${mailbox}.` : `No messages in ${mailbox}.`;
        }
        const pick = uids.slice(-limit).reverse(); // newest first
        const rows: string[] = [];
        for await (const msg of client.fetch(pick, { uid: true, envelope: true }, { uid: true })) {
          const env = msg.envelope;
          rows.push(
            `#${msg.uid} — from ${formatAddress(env?.from?.[0])}, ` +
              `"${env?.subject || "(no subject)"}"${shortDate(env?.date) ? `, ${shortDate(env?.date)}` : ""}`,
          );
        }
        const header = opts.unreadOnly
          ? `${rows.length} unread message(s) in ${mailbox} (newest first):`
          : `${rows.length} recent message(s) in ${mailbox} (newest first):`;
        return `${header}\n${rows.join("\n")}\n(Use email_read with a uid to read one in full.)`;
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    log.error("email list failed", { err: String(err) });
    return "I couldn't reach your email server to list messages.";
  }
}

/** Read one message in full by its uid. */
export async function readEmail(opts: { uid: number; mailbox?: string }): Promise<string> {
  const mailbox = opts.mailbox || "INBOX";
  if (!opts.uid || Number.isNaN(opts.uid)) return "I need a message uid to read (from email_list).";
  try {
    return await withClient(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msg = await client.fetchOne(String(opts.uid), { source: true }, { uid: true });
        if (!msg || !msg.source) return `I couldn't find message #${opts.uid} in ${mailbox}.`;
        const parsed = await simpleParser(msg.source);
        const htmlText = typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "";
        const body = (parsed.text || htmlText || "").trim();
        const trimmed = body.length > 2500 ? `${body.slice(0, 2500)}… (truncated)` : body;
        return (
          `From: ${parsed.from?.text || "unknown"}\n` +
          `Subject: ${parsed.subject || "(no subject)"}\n` +
          `Date: ${shortDate(parsed.date)}\n\n${trimmed || "(no readable text body)"}`
        );
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    log.error("email read failed", { err: String(err), uid: opts.uid });
    return "I couldn't read that message.";
  }
}

function buildDraftMime(opts: { from: string; to: string; subject: string; body: string }): string {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    opts.body,
  ].join("\r\n");
}

/** Save a draft to the Drafts folder. Never sends. */
export async function draftEmail(opts: { to: string; subject: string; body: string }): Promise<string> {
  if (!opts.to?.trim()) return "I need a recipient for the draft.";
  const folder = config.email.draftsFolder;
  const mime = buildDraftMime({
    from: config.email.from,
    to: opts.to,
    subject: opts.subject || "(no subject)",
    body: opts.body || "",
  });
  try {
    return await withClient(async (client) => {
      const res = await client.append(folder, mime, ["\\Draft"]);
      if (!res) return `I composed the draft but the server didn't confirm saving it to ${folder}.`;
      return `Saved a draft to ${folder}: to ${opts.to}, subject "${opts.subject || "(no subject)"}". Nothing was sent.`;
    });
  } catch (err) {
    log.error("email draft failed", { err: String(err), folder });
    return `I couldn't save the draft to "${folder}". The Drafts folder name may differ — check IMAP_DRAFTS_FOLDER.`;
  }
}

/** List available mailbox names — handy during setup to find the right Drafts folder. */
export async function listMailboxes(): Promise<string[]> {
  return withClient(async (client) => {
    const list = await client.list();
    return list.map((box) => box.path);
  });
}

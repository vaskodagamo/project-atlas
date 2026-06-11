import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import { log } from "../logger.js";

// Multi-account email over IMAP: read + draft only (no SMTP, nothing is ever sent). A "draft" is
// appended to the account's Drafts folder. Works for any IMAP host, including Gmail (use an app
// password; Gmail's Drafts folder is "[Gmail]/Drafts"). We connect per call and log out — simple and
// stateless; IMAP connect is ~1s which is fine for voice. All functions return a speakable string.

export interface MailAccount {
  label: string; // e.g. "work" | "personal"
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  draftsFolder: string;
  from: string;
}

function clientOptions(a: MailAccount): ImapFlowOptions {
  return {
    host: a.host,
    port: a.port,
    secure: a.tls,
    auth: { user: a.user, pass: a.password },
    logger: false, // silence imapflow's own pino logging
  };
}

async function withClient<T>(a: MailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow(clientOptions(a));
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

/** List recent (optionally unread) messages from a mailbox of one account. */
export async function listEmails(
  a: MailAccount,
  opts: { unreadOnly?: boolean; limit?: number; mailbox?: string },
): Promise<string> {
  const mailbox = opts.mailbox || "INBOX";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  try {
    return await withClient(a, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = await client.search(opts.unreadOnly ? { seen: false } : { all: true }, { uid: true });
        if (!uids || uids.length === 0) {
          return opts.unreadOnly
            ? `No unread messages in your ${a.label} ${mailbox}.`
            : `No messages in your ${a.label} ${mailbox}.`;
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
        const header = `${rows.length} ${opts.unreadOnly ? "unread" : "recent"} message(s) in your ${a.label} ${mailbox} (newest first):`;
        return `${header}\n${rows.join("\n")}\n(Use email_read with this account + a uid to read one in full.)`;
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    log.error("email list failed", { account: a.label, err: String(err) });
    return `I couldn't reach your ${a.label} email to list messages.`;
  }
}

/** Read one message in full by its uid from one account. */
export async function readEmail(a: MailAccount, opts: { uid: number; mailbox?: string }): Promise<string> {
  const mailbox = opts.mailbox || "INBOX";
  if (!opts.uid || Number.isNaN(opts.uid)) return "I need a message uid to read (from email_list).";
  try {
    return await withClient(a, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msg = await client.fetchOne(String(opts.uid), { source: true }, { uid: true });
        if (!msg || !msg.source) return `I couldn't find message #${opts.uid} in your ${a.label} ${mailbox}.`;
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
    log.error("email read failed", { account: a.label, err: String(err), uid: opts.uid });
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

/** Save a draft to one account's Drafts folder. Never sends. */
export async function draftEmail(
  a: MailAccount,
  opts: { to: string; subject: string; body: string },
): Promise<string> {
  if (!opts.to?.trim()) return "I need a recipient for the draft.";
  const mime = buildDraftMime({
    from: a.from,
    to: opts.to,
    subject: opts.subject || "(no subject)",
    body: opts.body || "",
  });
  try {
    return await withClient(a, async (client) => {
      const res = await client.append(a.draftsFolder, mime, ["\\Draft"]);
      if (!res) return `I composed the draft but your ${a.label} server didn't confirm saving it to ${a.draftsFolder}.`;
      return `Saved a draft to your ${a.label} ${a.draftsFolder}: to ${opts.to}, subject "${opts.subject || "(no subject)"}". Nothing was sent.`;
    });
  } catch (err) {
    log.error("email draft failed", { account: a.label, folder: a.draftsFolder, err: String(err) });
    return `I couldn't save the draft to "${a.draftsFolder}" on your ${a.label} account. The Drafts folder name may differ.`;
  }
}

/** List available mailbox names for an account — handy during setup to find the Drafts folder. */
export async function listMailboxes(a: MailAccount): Promise<string[]> {
  return withClient(a, async (client) => {
    const list = await client.list();
    return list.map((box) => box.path);
  });
}

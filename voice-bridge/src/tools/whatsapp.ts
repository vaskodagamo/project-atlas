import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from "baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { log } from "../logger.js";

// WhatsApp via Baileys (the multi-device / "linked device" protocol — like WhatsApp Web). This is an
// UNOFFICIAL client and violates WhatsApp's ToS; there is a small-but-real risk of the number being
// banned. First run prints a QR to scan from the phone (WhatsApp → Linked Devices); creds persist in
// .whatsapp-auth/ so later starts reconnect silently. We keep a small in-memory store of recent
// messages per chat (history before connect isn't available) and never send read receipts.

const AUTH_DIR = ".whatsapp-auth";
const MAX_PER_CHAT = 40;

interface StoredMessage {
  from: string; // "me" or the sender's name
  text: string;
  ts: number; // ms
  fromMe: boolean;
}

function extractText(m?: proto.IMessage | null): string {
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  );
}

function jidToNumber(jid: string): string {
  return jid.split("@")[0] ?? jid;
}

class WhatsAppClient {
  private sock: WASocket | null = null;
  private ready = false;
  private starting = false;
  private messages = new Map<string, StoredMessage[]>(); // jid -> recent messages
  private names = new Map<string, string>(); // jid -> display name
  private unread = new Map<string, number>(); // jid -> unread count

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }) as never,
        browser: ["Jarvis", "Chrome", "1.0"],
        markOnlineOnConnect: false, // stay invisible; don't flip the phone's presence
      });
      this.sock = sock;
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", (u) => this.onConnection(u));
      sock.ev.on("messages.upsert", (m) => this.onMessages(m));
      sock.ev.on("contacts.upsert", (cs) => this.rememberContacts(cs));
      sock.ev.on("contacts.update", (cs) => this.rememberContacts(cs));
    } finally {
      this.starting = false;
    }
  }

  private rememberContacts(cs: Array<{ id?: string | null; name?: string | null; notify?: string | null }>): void {
    for (const c of cs) {
      const name = c.name || c.notify;
      if (c.id && name) this.names.set(c.id, name);
    }
  }

  private onConnection(u: { connection?: string; lastDisconnect?: { error?: Error }; qr?: string }): void {
    if (u.qr) {
      log.info('WhatsApp: scan this QR in WhatsApp → Settings → Linked Devices → Link a device');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === "open") {
      this.ready = true;
      log.info("WhatsApp connected");
    }
    if (u.connection === "close") {
      this.ready = false;
      const code = (u.lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      log.warn("WhatsApp connection closed", { code, loggedOut });
      if (loggedOut) {
        log.warn("WhatsApp logged out — delete .whatsapp-auth/ and restart to re-link.");
      } else {
        setTimeout(() => this.start().catch((e) => log.error("WhatsApp reconnect failed", { err: String(e) })), 3000);
      }
    }
  }

  private onMessages(payload: { messages: proto.IWebMessageInfo[]; type: string }): void {
    if (payload.type !== "notify") return;
    for (const msg of payload.messages) {
      const jid = msg.key?.remoteJid;
      if (!jid || jid === "status@broadcast") continue;
      const text = extractText(msg.message);
      if (!text) continue;
      const fromMe = Boolean(msg.key?.fromMe);
      const name = msg.pushName || this.names.get(jid) || jidToNumber(jid);
      if (!fromMe && msg.pushName && !jid.endsWith("@g.us")) this.names.set(jid, msg.pushName);

      const arr = this.messages.get(jid) ?? [];
      arr.push({ from: fromMe ? "me" : name, text, ts: Number(msg.messageTimestamp) * 1000, fromMe });
      while (arr.length > MAX_PER_CHAT) arr.shift();
      this.messages.set(jid, arr);
      if (!fromMe) this.unread.set(jid, (this.unread.get(jid) ?? 0) + 1);
    }
  }

  private nameFor(jid: string): string {
    return this.names.get(jid) || jidToNumber(jid);
  }

  /** Best-effort resolve a spoken name or number to a chat JID. */
  private findJid(query: string): string | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    for (const [jid, name] of this.names) {
      if (name.toLowerCase().includes(q)) return jid;
    }
    for (const jid of this.messages.keys()) {
      if (this.nameFor(jid).toLowerCase().includes(q)) return jid;
    }
    const digits = query.replace(/[^0-9]/g, "");
    if (digits.length >= 6) return `${digits}@s.whatsapp.net`;
    return null;
  }

  isEnabledAndReady(): boolean {
    return this.ready;
  }

  listChats(): string {
    if (!this.ready) return "WhatsApp isn't connected yet — give it a moment after startup (or scan the QR).";
    const entries = [...this.messages.entries()]
      .map(([jid, arr]) => ({ name: this.nameFor(jid), last: arr[arr.length - 1], unread: this.unread.get(jid) ?? 0 }))
      .sort((a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0))
      .slice(0, 12);
    if (entries.length === 0) return "No WhatsApp chats have come in since I connected.";
    const lines = entries.map(
      (e) => `- ${e.name}${e.unread ? ` (${e.unread} unread)` : ""}: "${(e.last?.text ?? "").slice(0, 60)}"`,
    );
    return `Recent WhatsApp chats:\n${lines.join("\n")}`;
  }

  readChat(query: string): string {
    if (!this.ready) return "WhatsApp isn't connected yet.";
    const jid = this.findJid(query);
    if (!jid) return `I don't see a WhatsApp chat matching "${query}".\n${this.listChats()}`;
    const arr = this.messages.get(jid) ?? [];
    this.unread.set(jid, 0); // mark read locally only (no read receipts sent)
    if (arr.length === 0) return `No recent messages with ${this.nameFor(jid)} since I connected.`;
    const lines = arr.slice(-15).map((m) => `${m.from}: ${m.text}`);
    return `Recent WhatsApp messages with ${this.nameFor(jid)}:\n${lines.join("\n")}`;
  }

  async send(query: string, text: string): Promise<string> {
    if (!this.ready || !this.sock) return "WhatsApp isn't connected.";
    if (!text.trim()) return "There's no message text to send.";
    const jid = this.findJid(query);
    if (!jid) return `I couldn't find a WhatsApp contact matching "${query}".`;
    try {
      await this.sock.sendMessage(jid, { text });
      return `Sent to ${this.nameFor(jid)}: "${text}".`;
    } catch (err) {
      log.error("WhatsApp send failed", { err: String(err) });
      return "I couldn't send that WhatsApp message.";
    }
  }
}

export const whatsapp = new WhatsAppClient();

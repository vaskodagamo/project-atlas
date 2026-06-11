// Smoke test for IMAP email: connects, lists your mailboxes (so you can spot the right Drafts
// folder name), and shows recent unread. Reads creds from .env — nothing is sent.
//   npm run test:email
import { config } from "../src/config.js";
import { listMailboxes, listEmails } from "../src/tools/email.js";

if (!config.email.enabled) {
  console.log("IMAP not configured. Set IMAP_HOST, IMAP_USER and IMAP_PASSWORD in .env, then retry.");
  process.exit(1);
}

console.log(`Connecting to ${config.email.host}:${config.email.port} (TLS ${config.email.tls}) as ${config.email.user} …`);

const boxes = await listMailboxes();
console.log("\nMailboxes (set IMAP_DRAFTS_FOLDER to your Drafts one if it isn't 'Drafts'):");
for (const b of boxes) console.log(`  ${b}`);

console.log("\nRecent unread (up to 5):");
console.log(await listEmails({ unreadOnly: true, limit: 5 }));

process.exit(0);

// Smoke test for IMAP email across all configured accounts: connects, lists mailboxes (so you can
// confirm the Drafts folder name), and shows recent unread. Reads creds from .env — nothing is sent.
//   npm run test:email
import { config } from "../src/config.js";
import { listMailboxes, listEmails } from "../src/tools/email.js";

if (!config.email.enabled) {
  console.log("No email account configured. Set IMAP_* and/or GMAIL_USER + GMAIL_APP_PASSWORD in .env.");
  process.exit(1);
}

for (const account of config.email.accounts) {
  console.log(`\n=== account: ${account.label} (${account.user} @ ${account.host}:${account.port}) ===`);
  try {
    const boxes = await listMailboxes(account);
    console.log("Mailboxes (confirm the Drafts folder name):");
    for (const b of boxes) console.log(`  ${b}`);
    console.log("Recent unread (up to 5):");
    console.log(await listEmails(account, { unreadOnly: true, limit: 5 }));
  } catch (err) {
    console.log(`  FAILED: ${String(err)}`);
  }
}

process.exit(0);

// Find WiZ smart bulbs on your LAN by UDP broadcast, so you can set WIZ_LIGHT_IP.
//   npm run wiz-discover            # broadcasts to 192.168.178.255
//   npm run wiz-discover -- 10.0.0.255
import { discover } from "../src/tools/wiz.js";

const broadcast = process.argv[2] ?? "192.168.178.255";
console.log(`Broadcasting WiZ discovery to ${broadcast}:38899 (listening 4s)…`);
const found = await discover(broadcast);
if (found.length === 0) {
  console.log("No WiZ bulbs replied. Check the bulb is powered on and on the same network/subnet.");
} else {
  console.log("Found WiZ bulb(s):");
  for (const b of found) console.log(`  IP ${b.ip}${b.mac ? `   MAC ${b.mac}` : ""}`);
  console.log("\nSet WIZ_LIGHT_IP in .env to the bulb's IP above.");
}
process.exit(0);

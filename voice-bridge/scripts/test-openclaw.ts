// Smoke test for the OpenClaw tool path: calls the real askOpenclaw() against the running gateway.
//   npm run test:openclaw            # default recall question
//   npm run test:openclaw -- "..."   # custom prompt
import { askOpenclaw } from "../src/tools/openclaw.js";

const prompt = process.argv[2] ?? "In one short sentence, what is my office location and my role?";
console.log("→", prompt);
const reply = await askOpenclaw(prompt);
console.log("←", reply);
process.exit(0);

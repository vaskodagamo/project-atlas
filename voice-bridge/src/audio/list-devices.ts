// `npm run list-devices` — print the CoreAudio capture devices ffmpeg can see, so you can confirm
// the EMEET 360 shows up and pick the right EMEET_DEVICE_NAME substring. (Output/playback uses the
// system default device, so set the EMEET as your default output in System Settings → Sound.)
import { listAudioInputs } from "./devices.js";

const inputs = listAudioInputs();
if (inputs.length === 0) {
  console.log("No audio inputs found. Is the EMEET plugged in? Is microphone permission granted?");
  process.exit(0);
}

console.log("Audio inputs (capture):");
console.log("index  name");
console.log("-----  --------------------------------------------");
for (const d of inputs) {
  console.log(`${String(d.index).padStart(5)}  ${d.name}`);
}
console.log("\nSet EMEET_DEVICE_NAME to a substring of the EMEET's name (default: EMEET).");
console.log("Playback goes to the system DEFAULT output — set the EMEET as default in Sound settings.");

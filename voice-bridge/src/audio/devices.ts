import { spawnSync } from "node:child_process";

// Audio I/O is done by shelling out to ffmpeg (capture) and ffplay (playback) — both ship in the
// Homebrew `ffmpeg` formula and need no native compilation (unlike PortAudio bindings, which don't
// build cleanly on current Node). This module just enumerates CoreAudio inputs via ffmpeg's
// avfoundation device and resolves the EMEET to an index.

export interface AudioInput {
  index: number;
  name: string;
}

/** Run ffmpeg's device lister; it exits non-zero and prints the list to stderr — that's expected. */
function rawDeviceList(): string {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { encoding: "utf8" },
  );
  if (r.error) {
    throw new Error(
      `Could not run ffmpeg (${r.error.message}). Install it with: brew install ffmpeg`,
    );
  }
  return `${r.stderr ?? ""}${r.stdout ?? ""}`;
}

/** All CoreAudio capture devices ffmpeg can see, with their avfoundation indices. */
export function listAudioInputs(): AudioInput[] {
  const lines = rawDeviceList().split("\n");
  const inputs: AudioInput[] = [];
  let inAudioSection = false;
  for (const line of lines) {
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;
    const m = line.match(/\[(\d+)\]\s+(.*\S)\s*$/);
    if (m) inputs.push({ index: Number(m[1]), name: m[2]! });
  }
  return inputs;
}

/** Resolve the EMEET (or whatever EMEET_DEVICE_NAME matches) to a capture device index. */
export function findEmeetInput(nameMatch: string): AudioInput {
  const re = new RegExp(nameMatch, "i");
  const inputs = listAudioInputs();
  const dev = inputs.find((d) => re.test(d.name));
  if (!dev) {
    const avail = inputs.map((d) => `  [${d.index}] ${d.name}`).join("\n");
    throw new Error(
      `No audio input matching /${nameMatch}/i was found.\n` +
        `Plug in the EMEET 360 and/or fix EMEET_DEVICE_NAME. Available inputs:\n` +
        (avail || "  (none — check ffmpeg works and microphone permission is granted)"),
    );
  }
  return dev;
}

import { exec as cpExec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../logger.js";

// Mac control via `open`, `osascript` (AppleScript) and the shell. The curated actions below are
// safe and run instantly; arbitrary run_shell / run_applescript are powerful and are gated behind a
// spoken confirmation in the dispatcher. Note: AppleScript that controls other apps will trigger
// macOS Automation permission prompts the first time (grant them once).
const execFileP = promisify(execFile);
const execP = promisify(cpExec);

function trunc(s: string, n = 1500): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}… (truncated)` : t;
}

async function osa(script: string, timeoutMs = 12000): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", script], { timeout: timeoutMs });
  return stdout.trim();
}

export async function openApp(name: string): Promise<string> {
  if (!name.trim()) return "Which app should I open?";
  try {
    await execFileP("open", ["-a", name], { timeout: 8000 });
    return `Opened ${name}.`;
  } catch (err) {
    log.error("openApp failed", { name, err: String(err) });
    return `I couldn't open "${name}". Is it installed?`;
  }
}

export async function setVolume(percent: number): Promise<string> {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  try {
    await osa(`set volume output volume ${p}`);
    return `Volume set to ${p}%.`;
  } catch (err) {
    log.error("setVolume failed", { p, err: String(err) });
    return "I couldn't set the volume.";
  }
}

export async function macSystem(action: string): Promise<string> {
  try {
    switch (action) {
      case "mute":
        await osa("set volume with output muted");
        return "Muted.";
      case "unmute":
        await osa("set volume without output muted");
        return "Unmuted.";
      case "volume_up":
        await osa("set volume output volume ((output volume of (get volume settings)) + 15)");
        return "Turned the volume up.";
      case "volume_down":
        await osa("set volume output volume ((output volume of (get volume settings)) - 15)");
        return "Turned the volume down.";
      case "sleep_display":
      case "lock":
        await execFileP("pmset", ["displaysleepnow"], { timeout: 6000 });
        return action === "lock" ? "Locking — display asleep." : "Display going to sleep.";
      case "frontmost_app": {
        const a = await osa('tell application "System Events" to get name of first application process whose frontmost is true');
        return `The frontmost app is ${a}.`;
      }
      case "running_apps": {
        const a = await osa('tell application "System Events" to get name of every application process whose background only is false');
        return `Open apps: ${a}.`;
      }
      default:
        return `Unknown system action "${action}".`;
    }
  } catch (err) {
    log.error("macSystem failed", { action, err: String(err) });
    return `I couldn't do "${action}".`;
  }
}

export async function runAppleScript(script: string): Promise<string> {
  if (!script.trim()) return "No AppleScript was provided.";
  try {
    const out = await osa(script, 20000);
    return out ? trunc(out) : "Done.";
  } catch (err) {
    const e = err as { stderr?: string };
    log.error("runAppleScript failed", { err: String(err) });
    return `AppleScript error: ${trunc(e.stderr || String(err), 300)}`;
  }
}

export async function runShell(command: string): Promise<string> {
  if (!command.trim()) return "No command was provided.";
  try {
    const { stdout, stderr } = await execP(command, { timeout: 20000, maxBuffer: 1024 * 1024 });
    const out = (stdout || "").trim() || (stderr || "").trim();
    return out ? trunc(out) : "Command finished with no output.";
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    log.error("runShell failed", { err: String(err) });
    return `Command failed: ${trunc(e.stderr || e.message || String(err), 400)}`;
  }
}

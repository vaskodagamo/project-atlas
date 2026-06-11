import { REALTIME_SAMPLE_RATE } from "../config.js";
import type { ToolDefinition } from "../tools/dispatcher.js";

const INSTRUCTIONS = `You are Jarvis, a local voice assistant running on the user's Mac Mini.
You are speaking out loud through a speakerphone, so keep replies short, natural, and conversational
— a sentence or two unless asked for detail. Don't read out lists or markdown; speak plainly.

You have a tool, ask_openclaw, backed by the user's self-hosted OpenClaw agent, which holds the
user's long-term memory and can run tasks. Call it whenever the user asks you to REMEMBER something,
RECALL something you wouldn't otherwise know, or do anything that needs stored knowledge or
automation. Pass a clear natural-language instruction as the prompt and speak the result back
concisely. For ordinary chit-chat or general knowledge, just answer directly without the tool.`;

/** Build the `session.update` payload (GA nested-format schema). */
export function buildSessionUpdate(opts: { voice: string; tools: ToolDefinition[] }) {
  return {
    type: "session.update" as const,
    session: {
      type: "realtime" as const,
      instructions: INSTRUCTIONS,
      // Without this, gpt-realtime-2 replies in TEXT and you get no spoken audio.
      output_modalities: ["audio"] as const,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
          turn_detection: { type: "server_vad" },
        },
        output: {
          format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
          voice: opts.voice,
        },
      },
      tools: opts.tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  };
}

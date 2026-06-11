import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";
import { log } from "../logger.js";
import { base64ToInt16, int16ToBase64 } from "../audio/pcm.js";
import { getToolDefinitions } from "../tools/dispatcher.js";
import { buildSessionUpdate } from "./session.js";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

export interface FunctionCall {
  name: string;
  callId: string;
  args: string; // raw JSON string of arguments
}

/**
 * Thin client over the OpenAI Realtime WebSocket. Streams 24 kHz PCM16 up, surfaces audio deltas,
 * barge-in (speech_started), and function calls as events. The brain (gpt-realtime-2) runs the
 * conversation; we just move audio and broker tool calls.
 *
 * Events: "ready", "audio" (Int16Array @24k), "speech_started", "function_call" (FunctionCall),
 *         "assistant_done", "error" (Error), "close".
 */
export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private _ready = false;
  // item_id -> { callId, name } so we can resolve a function name when arguments.done arrives.
  private pendingCalls = new Map<string, { callId: string; name: string }>();
  // call_ids already dispatched, so the two delivery paths (arguments.done + response.done) fire once.
  private dispatchedCalls = new Set<string>();
  private responseActive = false; // is the model currently generating a response?
  private suppressAudio = false; // drop audio of a response we've interrupted, until the next one starts
  private audioChunks = 0; // audio deltas emitted for the current response (0 => text-only reply)

  get ready(): boolean {
    return this._ready;
  }

  /** Open the socket and apply the session config. Resolves once the session is ready to stream. */
  connect(): Promise<void> {
    const url = `${REALTIME_URL}?model=${encodeURIComponent(config.openai.model)}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    });
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      const onReady = (): void => resolve();
      const failTimer = setTimeout(() => reject(new Error("Realtime session did not become ready in time")), 10000);

      this.once("ready", () => {
        clearTimeout(failTimer);
        onReady();
      });

      ws.on("open", () => {
        log.debug("realtime socket open; sending session.update");
        this.send(buildSessionUpdate({ voice: config.openai.voice, tools: getToolDefinitions() }));
      });
      ws.on("message", (data: WebSocket.RawData) => this.onMessage(data));
      ws.on("error", (err: Error) => {
        clearTimeout(failTimer);
        this.emit("error", err);
        reject(err);
      });
      ws.on("close", () => {
        this._ready = false;
        this.emit("close");
      });
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log.warn("non-JSON realtime message");
      return;
    }
    const type = msg.type ?? "";

    switch (type) {
      case "session.created":
        log.debug("realtime session.created");
        break;

      case "session.updated":
        this._ready = true;
        this.emit("ready");
        break;

      // The user started speaking -> barge-in. Suppress any remaining audio of the response being
      // interrupted (so a killed/again-respawned player can't resume the old reply).
      case "input_audio_buffer.speech_started":
        this.suppressAudio = true;
        this.emit("speech_started");
        break;

      // A new model response is starting -> it's allowed to play.
      case "response.created":
        this.responseActive = true;
        this.suppressAudio = false;
        this.audioChunks = 0;
        this.emit("response_started");
        break;

      // Model audio output (GA name + older alias).
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (this.suppressAudio) break;
        const b64 = typeof msg.delta === "string" ? msg.delta : "";
        if (b64) {
          this.audioChunks++;
          if (this.audioChunks === 1) log.debug("receiving reply audio from model");
          this.emit("audio", base64ToInt16(b64));
        }
        break;
      }

      // A function-call item is announced; remember its name keyed by item id.
      case "response.output_item.added": {
        const item = msg.item as { id?: string; type?: string; name?: string; call_id?: string } | undefined;
        if (item?.type === "function_call" && item.id && item.call_id && item.name) {
          this.pendingCalls.set(item.id, { callId: item.call_id, name: item.name });
        }
        break;
      }

      // Streaming arguments complete -> dispatch (one delivery path).
      case "response.function_call_arguments.done": {
        const itemId = typeof msg.item_id === "string" ? msg.item_id : "";
        const tracked = this.pendingCalls.get(itemId);
        const callId = (typeof msg.call_id === "string" && msg.call_id) || tracked?.callId || "";
        const name = (typeof msg.name === "string" && msg.name) || tracked?.name || "";
        const args = typeof msg.arguments === "string" ? msg.arguments : "{}";
        this.pendingCalls.delete(itemId);
        this.dispatchCall(name, callId, args);
        break;
      }

      // The completed response may also carry function_call items (the other delivery path).
      case "response.done": {
        const response = msg.response as
          | { output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }> }
          | undefined;
        for (const item of response?.output ?? []) {
          if (item?.type === "function_call" && item.call_id && item.name) {
            this.dispatchCall(item.name, item.call_id, typeof item.arguments === "string" ? item.arguments : "{}");
          }
        }
        this.responseActive = false;
        log.debug("reply complete", { audioChunks: this.audioChunks });
        this.emit("assistant_done");
        break;
      }

      // Server-side interruption (server_vad auto-cancels on barge-in) or an explicit cancel.
      case "response.cancelled":
      case "response.canceled":
        this.responseActive = false;
        break;

      case "error": {
        const err = msg.error as { code?: string } | undefined;
        // Benign: a cancel that raced a just-finished response. Not worth alarming the user.
        if (err?.code === "response_cancel_not_active") {
          log.debug("ignoring benign response_cancel_not_active");
          break;
        }
        this.emit("error", new Error(JSON.stringify(msg.error ?? msg)));
        break;
      }

      default:
        log.debug("realtime event", { type });
    }
  }

  /** Emit a function_call exactly once, regardless of which event delivered it. */
  private dispatchCall(name: string, callId: string, args: string): void {
    if (!name || !callId) {
      log.warn("function_call missing name/callId", { name, callId });
      return;
    }
    if (this.dispatchedCalls.has(callId)) return;
    this.dispatchedCalls.add(callId);
    this.emit("function_call", { name, callId, args } satisfies FunctionCall);
  }

  /** Stream a chunk of 24 kHz PCM16 mic audio to the model. */
  appendAudio(samples: Int16Array): void {
    if (!this._ready || this.ws?.readyState !== WebSocket.OPEN || samples.length === 0) return;
    this.send({ type: "input_audio_buffer.append", audio: int16ToBase64(samples) });
  }

  /** Stop the in-progress spoken response (barge-in). No-op if nothing is generating, which avoids
   *  the server's "Cancellation failed: no active response found" error on a first/idle utterance. */
  cancelResponse(): void {
    if (!this.responseActive) return;
    this.responseActive = false;
    this.send({ type: "response.cancel" });
  }

  /** Return a tool result to the model and let it speak the outcome. */
  sendFunctionResult(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    this.send({ type: "response.create" });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this._ready = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.pendingCalls.clear();
    this.dispatchedCalls.clear();
    this.responseActive = false;
    this.suppressAudio = false;
  }
}

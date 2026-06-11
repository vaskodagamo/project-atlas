import dgram from "node:dgram";
import { config } from "../config.js";
import { log } from "../logger.js";

// WiZ smart lights speak a simple local UDP/JSON protocol on port 38899 — no cloud, no account.
// We send {"method":"setPilot","params":{...}} to the bulb's LAN IP. Fully local and fast.

const WIZ_PORT = 38899;

const COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  orange: [255, 110, 0], purple: [160, 0, 255], violet: [160, 0, 255], pink: [255, 80, 180],
  magenta: [255, 0, 255], cyan: [0, 255, 255], turquoise: [0, 200, 180], teal: [0, 180, 180],
  lime: [160, 255, 0], gold: [255, 190, 40], white: [255, 255, 255],
};

const WHITES: Record<string, number> = { warm: 2700, neutral: 4000, cool: 6500, daylight: 6500 };

const SCENES: Record<string, number> = {
  ocean: 1, romance: 2, party: 4, fireplace: 5, cozy: 6, forest: 7, pastel: 8, "wake up": 9,
  bedtime: 10, "warm white": 11, daylight: 12, "cool white": 13, "night light": 14, night: 14,
  focus: 15, relax: 16, "true colors": 17, "tv time": 18, spring: 20, summer: 21, fall: 22,
  club: 26, christmas: 27, halloween: 28, candlelight: 29, "golden white": 30,
};

/** Send one UDP command to a WiZ bulb and resolve its JSON reply (or null on timeout/error). */
function rpc(ip: string, method: string, params: Record<string, unknown>, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const payload = Buffer.from(JSON.stringify({ method, params }));
    let done = false;
    const finish = (value: Record<string, unknown> | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("message", (msg) => {
      try {
        finish(JSON.parse(msg.toString()) as Record<string, unknown>);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    // Bind before sending so the reply is reliably received (matches the discovery socket).
    socket.bind(() => {
      socket.send(payload, WIZ_PORT, ip, (err) => {
        if (err) finish(null);
      });
    });
  });
}

export async function controlLight(opts: {
  power?: string;
  brightness?: number;
  color?: string;
  white?: string;
  scene?: string;
}): Promise<string> {
  const { ip, name } = config.wiz;
  if (!ip) return "No light is configured.";

  if (opts.power === "off") {
    const r = await rpc(ip, "setPilot", { state: false });
    return r ? `Turned the ${name} off.` : `I couldn't reach the ${name} at ${ip}.`;
  }

  const params: Record<string, unknown> = {};
  const desc: string[] = [];
  if (opts.power === "on") {
    params.state = true;
    desc.push("on");
  }
  if (typeof opts.brightness === "number" && !Number.isNaN(opts.brightness)) {
    params.state = true;
    params.dimming = Math.max(10, Math.min(100, Math.round(opts.brightness)));
    desc.push(`${params.dimming}% brightness`);
  }
  if (opts.scene) {
    const id = SCENES[opts.scene.toLowerCase().trim()];
    if (id) {
      params.state = true;
      params.sceneId = id;
      desc.push(`${opts.scene} scene`);
    }
  }
  if (opts.white) {
    const temp = WHITES[opts.white.toLowerCase().trim()];
    if (temp) {
      params.state = true;
      params.temp = temp;
      desc.push(`${opts.white} white`);
    }
  }
  if (opts.color) {
    const rgb = COLORS[opts.color.toLowerCase().trim()];
    if (rgb) {
      params.state = true;
      [params.r, params.g, params.b] = rgb;
      delete params.temp; // color and white temperature are mutually exclusive on WiZ
      desc.push(opts.color);
    } else {
      desc.push(`(I don't know the colour "${opts.color}")`);
    }
  }

  if (Object.keys(params).length === 0) {
    return "Tell me what to do with the light — turn it on/off, a colour, a brightness, warm/cool white, or a scene.";
  }
  const r = await rpc(ip, "setPilot", params);
  return r ? `Set the ${name}: ${desc.join(", ")}.` : `I couldn't reach the ${name} at ${ip}.`;
}

export async function lightStatus(): Promise<string> {
  const { ip, name } = config.wiz;
  if (!ip) return "No light is configured.";
  const r = await rpc(ip, "getPilot", {});
  const result = r?.result as { state?: boolean; dimming?: number; temp?: number } | undefined;
  if (!result) return `I couldn't reach the ${name} at ${ip}.`;
  if (!result.state) return `The ${name} is off.`;
  const bits = [`on`];
  if (typeof result.dimming === "number") bits.push(`${result.dimming}% brightness`);
  if (typeof result.temp === "number") bits.push(`${result.temp}K white`);
  return `The ${name} is ${bits.join(", ")}.`;
}

/** Broadcast discovery — find WiZ bulbs on the LAN. Used by `npm run wiz-discover`. */
export function discover(broadcastAddr: string, timeoutMs = 4000): Promise<Array<{ ip: string; mac: string }>> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const found = new Map<string, string>();
    socket.on("message", (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString()) as { result?: { mac?: string } };
        found.set(rinfo.address, data.result?.mac ?? "");
      } catch {
        /* ignore non-WiZ replies */
      }
    });
    socket.on("error", (e) => log.error("wiz discover error", { err: String(e) }));
    socket.bind(() => {
      socket.setBroadcast(true);
      const payload = Buffer.from(JSON.stringify({ method: "getPilot", params: {} }));
      socket.send(payload, WIZ_PORT, broadcastAddr);
    });
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve([...found.entries()].map(([ip, mac]) => ({ ip, mac })));
    }, timeoutMs);
  });
}

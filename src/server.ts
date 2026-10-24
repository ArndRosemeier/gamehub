// GameHub - a universal, in-memory game-state relay for TypeScript games.
//
// One process, no per-game server code: apps own rooms, rooms carry an opaque game state
// (snapshot + deltas) that the room HOST publishes, and every other player receives it.
// Nothing is written to disk; rooms live in memory and expire shortly after the last player leaves.
//
// Access is decided PER APP in the config file:
//   access "key"        - public endpoint, the game presents an app key (x-app-key header or ?key=)
//   access "cloudflare" - the request must come through the Cloudflare Access protected /access/ path
//                         and carry a valid Access JWT (verified here against the team's JWKS)
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, randomInt } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";

// Constant on purpose (same rule as ServerStore): exposure is the tunnel's job, never config.
const HOST = "127.0.0.1";
const PORT = Number(process.env.GAMEHUB_PORT ?? 8490);
const CONFIG_PATH = process.env.GAMEHUB_CONFIG ?? "/home/administrator/gamehub-config/apps.json";
const SDK_PATH = join(dirname(fileURLToPath(import.meta.url)), "sdk.js");
const DEFAULT_ORIGINS = ["https://apps.futuremagic.de"];

const LIMITS = {
  maxPayload: 1 << 20,          // bytes per message (state snapshots included)
  maxConnections: 500,
  rateBurst: 120,               // messages
  ratePerSec: 60,
  emptyRoomTtlMs: 60_000,       // a host can reload and come back to the same room code
  maxDeltas: 1000,              // history kept for late joiners since the last snapshot
  maxDeltaBytes: 4 << 20,
  heartbeatMs: 30_000,
  nameMax: 32,
  roomNameMax: 64,
};

type AccessMode = "key" | "cloudflare";
type AppConfig = {
  name?: string; access: AccessMode; keyHashes?: string[];
  maxRooms?: number; maxPlayersPerRoom?: number; allowedOrigins?: string[]; aud?: string;
};
type Config = { cloudflare?: { teamDomain?: string; aud?: string }; allowedOrigins?: string[]; apps: Record<string, AppConfig> };

function log(...a: unknown[]) { console.error(new Date().toISOString(), ...a); }

// ---- config: re-read whenever the file changes, so app edits need no restart ----
let config: Config = { apps: {} };
let configMtime = -1;
let badMtime = -1;
function loadConfig(): Config {
  try {
    const st = statSync(CONFIG_PATH);
    if (st.mtimeMs !== configMtime && st.mtimeMs !== badMtime) {
      try {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
        if (!parsed || typeof parsed.apps !== "object") throw new Error("no apps object");
        config = parsed; configMtime = st.mtimeMs;
        log("config loaded:", Object.keys(config.apps).length, "app(s)");
      } catch (e) { badMtime = st.mtimeMs; log("config rejected, keeping previous:", (e as Error).message); }
    }
  } catch (e) { if (configMtime === -1 && badMtime === -1) { badMtime = 0; log("config unavailable:", (e as Error).message); } }
  return config;
}
function getApp(id: string): AppConfig | undefined {
  const cfg = loadConfig();
  return Object.hasOwn(cfg.apps, id) ? cfg.apps[id] : undefined;
}

// ---- auth ----
type Auth = { ok: true; who: string; app: AppConfig } | { ok: false; status: number; code: string };
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
function keyMatches(presented: string, hashes: string[]): boolean {
  const h = Buffer.from(sha256hex(presented), "hex");
  let ok = false;
  for (const x of hashes) { const b = Buffer.from(x, "hex"); if (b.length === h.length && timingSafeEqual(b, h)) ok = true; }
  return ok;
}
function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const jwksCache = new Map<string, { at: number; keys: any[] }>();
async function accessKeys(team: string, force = false): Promise<any[]> {
  const c = jwksCache.get(team);
  if (c && !force && Date.now() - c.at < 3_600_000) return c.keys;
  const r = await fetch("https://" + team + "/cdn-cgi/access/certs", { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("access certs HTTP " + r.status);
  const keys = ((await r.json()) as any).keys ?? [];
  jwksCache.set(team, { at: Date.now(), keys });
  return keys;
}
async function verifyAccessJwt(token: string, team: string, aud: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: any, payload: any;
  try { header = JSON.parse(b64url(parts[0]).toString()); payload = JSON.parse(b64url(parts[1]).toString()); } catch { return null; }
  if (header.alg !== "RS256") return null;
  let keys = await accessKeys(team);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await accessKeys(team, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return null;
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), createPublicKey({ key: jwk, format: "jwk" }), b64url(parts[2]));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (typeof payload.exp !== "number" || payload.exp < now - 30) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== "https://" + team) return null;
  return String(payload.email ?? payload.sub ?? "access-user");
}
async function authorize(req: IncomingMessage, appId: string, viaAccess: boolean, url: URL): Promise<Auth> {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, code: "unknown_app" };
  if (app.access === "key") {
    const presented = (req.headers["x-app-key"] as string | undefined) ?? url.searchParams.get("key") ?? "";
    if (!presented || !keyMatches(presented, app.keyHashes ?? [])) return { ok: false, status: 401, code: "bad_key" };
    return { ok: true, who: "key", app };
  }
  if (app.access === "cloudflare") {
    if (!viaAccess) return { ok: false, status: 403, code: "use_access_path" };
    const team = config.cloudflare?.teamDomain;
    const aud = app.aud ?? config.cloudflare?.aud;
    if (!team || !aud) return { ok: false, status: 503, code: "access_not_configured" };
    const token = (req.headers["cf-access-jwt-assertion"] as string | undefined) ?? cookie(req, "CF_Authorization");
    if (!token) return { ok: false, status: 401, code: "no_access_token" };
    let who: string | null = null;
    try { who = await verifyAccessJwt(token, team, aud); } catch (e) { log("access verify failed:", (e as Error).message); return { ok: false, status: 503, code: "access_unavailable" }; }
    if (!who) return { ok: false, status: 401, code: "bad_access_token" };
    return { ok: true, who, app };
  }
  return { ok: false, status: 500, code: "bad_app_config" };
}
function allowedOrigins(app?: AppConfig): string[] { return app?.allowedOrigins ?? config.allowedOrigins ?? DEFAULT_ORIGINS; }

// ---- rooms ----
type Player = {
  id: number; name: string; ws: WebSocket; appId: string; who: string; room: Room | null;
  tokens: number; tokensAt: number; throttledAt: number; alive: boolean;
};
type Room = {
  id: string; appId: string; name: string; public: boolean; maxPlayers: number; meta: unknown;
  players: Map<number, Player>; hostId: number; seq: number;
  snapshot: unknown; snapshotSeq: number; deltas: { seq: number; data: unknown }[]; deltaBytes: number;
  historyBroken: boolean; snapshotRequested: boolean; createdAt: number; emptySince: number | null;
};
type AppState = { rooms: Map<string, Room>; lobby: Set<Player> };
const appStates = new Map<string, AppState>();
const players = new Set<Player>();
let nextPlayerId = 1;

function appState(id: string): AppState {
  let s = appStates.get(id);
  if (!s) { s = { rooms: new Map(), lobby: new Set() }; appStates.set(id, s); }
  return s;
}
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRoomId(rooms: Map<string, Room>): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(s)) return s;
  }
}
const summary = (r: Room) => ({ id: r.id, name: r.name, public: r.public, players: r.players.size, maxPlayers: r.maxPlayers, meta: r.meta, host: r.hostId, createdAt: r.createdAt });
function listRooms(appId: string) {
  return [...appState(appId).rooms.values()].filter((r) => r.public && r.players.size > 0)
    .sort((a, b) => b.createdAt - a.createdAt).map(summary);
}
function send(p: Player, msg: object) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function broadcast(r: Room, msg: object, except?: number) {
  const s = JSON.stringify(msg);
  for (const [id, p] of r.players) if (id !== except && p.ws.readyState === 1) p.ws.send(s);
}
function lobbyNotify(r: Room) {
  const st = appState(r.appId);
  if (!st.lobby.size) return;
  const gone = !st.rooms.has(r.id) || !r.public || r.players.size === 0;
  const s = JSON.stringify(gone ? { t: "room-", id: r.id } : { t: "room+", room: summary(r) });
  for (const p of st.lobby) if (p.ws.readyState === 1) p.ws.send(s);
}
function joinRoom(p: Player, r: Room, req: unknown) {
  leaveRoom(p);
  r.players.set(p.id, p);
  p.room = r;
  r.emptySince = null;
  if (!r.players.has(r.hostId)) r.hostId = p.id;   // first player back into an emptied room hosts it
  send(p, {
    t: "joined", req, room: summary(r), you: p.id, host: r.hostId,
    players: [...r.players.values()].map((x) => ({ id: x.id, name: x.name })),
    state: { seq: r.seq, snapshotSeq: r.snapshotSeq, snapshot: r.snapshot, deltas: r.deltas, complete: !r.historyBroken },
  });
  broadcast(r, { t: "player+", player: { id: p.id, name: p.name } }, p.id);
  if (r.historyBroken && r.hostId !== p.id) { const h = r.players.get(r.hostId); if (h) send(h, { t: "need-snapshot" }); }
  lobbyNotify(r);
}
function leaveRoom(p: Player) {
  const r = p.room;
  if (!r) return;
  r.players.delete(p.id);
  p.room = null;
  broadcast(r, { t: "player-", id: p.id });
  if (r.players.size === 0) r.emptySince = Date.now();
  else if (r.hostId === p.id) { r.hostId = Math.min(...r.players.keys()); broadcast(r, { t: "host", id: r.hostId }); }
  lobbyNotify(r);
}
function allow(p: Player): boolean {
  const now = Date.now();
  p.tokens = Math.min(LIMITS.rateBurst, p.tokens + ((now - p.tokensAt) * LIMITS.ratePerSec) / 1000);
  p.tokensAt = now;
  if (p.tokens < 1) {
    if (now - p.throttledAt > 1000) { p.throttledAt = now; send(p, { t: "error", code: "rate_limited" }); }
    return false;
  }
  p.tokens -= 1;
  return true;
}
function onText(p: Player, raw: string) {
  let m: any;
  try { m = JSON.parse(raw); } catch { return send(p, { t: "error", code: "bad_json" }); }
  if (!m || typeof m.t !== "string") return send(p, { t: "error", code: "bad_message" });
  const req = m.req;
  const r = p.room;
  const app = getApp(p.appId);
  switch (m.t) {
    case "hello":
      if (typeof m.name === "string" && m.name.trim()) p.name = m.name.trim().slice(0, LIMITS.nameMax);
      return send(p, { t: "welcome", req, you: p.id, name: p.name, app: p.appId });
    case "lobby": {
      const st = appState(p.appId);
      if (m.on === false) { st.lobby.delete(p); return send(p, { t: "lobby-off", req }); }
      st.lobby.add(p);
      return send(p, { t: "rooms", req, rooms: listRooms(p.appId) });
    }
    case "create": {
      const st = appState(p.appId);
      if (st.rooms.size >= (app?.maxRooms ?? 100)) return send(p, { t: "error", req, code: "too_many_rooms" });
      const o = m.room && typeof m.room === "object" ? m.room : {};
      const cap = app?.maxPlayersPerRoom ?? 16;
      const room: Room = {
        id: newRoomId(st.rooms), appId: p.appId,
        name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, LIMITS.roomNameMax) : "Room",
        public: o.public !== false,
        maxPlayers: Math.max(1, Math.min(cap, Number.isInteger(o.maxPlayers) ? o.maxPlayers : cap)),
        meta: o.meta ?? null, players: new Map(), hostId: p.id, seq: 0,
        snapshot: null, snapshotSeq: 0, deltas: [], deltaBytes: 0, historyBroken: false, snapshotRequested: false,
        createdAt: Date.now(), emptySince: null,
      };
      st.rooms.set(room.id, room);
      log("room created", p.appId, room.id, room.public ? "public" : "private");
      return joinRoom(p, room, req);
    }
    case "join": {
      const room = typeof m.id === "string" ? appState(p.appId).rooms.get(m.id.trim().toUpperCase()) : undefined;
      if (!room) return send(p, { t: "error", req, code: "no_such_room" });
      if (room.players.has(p.id)) return send(p, { t: "error", req, code: "already_in_room" });
      if (room.players.size >= room.maxPlayers) return send(p, { t: "error", req, code: "room_full" });
      return joinRoom(p, room, req);
    }
    case "leave":
      leaveRoom(p);
      return send(p, { t: "left", req });
    case "state":
    case "delta":
    case "meta": {
      if (!r) return send(p, { t: "error", req, code: "not_in_room" });
      if (r.hostId !== p.id) return send(p, { t: "error", req, code: "not_host" });
      if (m.t === "state") {
        r.seq++;
        r.snapshot = m.data ?? null; r.snapshotSeq = r.seq;
        r.deltas = []; r.deltaBytes = 0; r.historyBroken = false; r.snapshotRequested = false;
        return broadcast(r, { t: "state", seq: r.seq, data: r.snapshot }, p.id);
      }
      if (m.t === "delta") {
        r.seq++;
        const data = m.data ?? null;
        if (!r.historyBroken) {
          r.deltas.push({ seq: r.seq, data });
          r.deltaBytes += raw.length;
          if (r.deltas.length > LIMITS.maxDeltas || r.deltaBytes > LIMITS.maxDeltaBytes) {
            r.historyBroken = true; r.deltas = []; r.deltaBytes = 0;   // late joiners now wait for the next snapshot
            send(p, { t: "need-snapshot" });
          } else if (!r.snapshotRequested && (r.deltas.length > LIMITS.maxDeltas / 2 || r.deltaBytes > LIMITS.maxDeltaBytes / 2)) {
            r.snapshotRequested = true;
            send(p, { t: "need-snapshot" });
          }
        }
        return broadcast(r, { t: "delta", seq: r.seq, data }, p.id);
      }
      if (typeof m.name === "string" && m.name.trim()) r.name = m.name.trim().slice(0, LIMITS.roomNameMax);
      if (typeof m.public === "boolean") r.public = m.public;
      if ("meta" in m) r.meta = m.meta ?? null;
      broadcast(r, { t: "room", room: summary(r) });
      return lobbyNotify(r);
    }
    case "msg": {
      if (!r) return send(p, { t: "error", req, code: "not_in_room" });
      const out = JSON.stringify({ t: "msg", from: p.id, data: m.data ?? null });
      if (typeof m.to === "number") { const q = r.players.get(m.to); if (q && q.ws.readyState === 1) q.ws.send(out); return; }
      for (const [id, q] of r.players) if (id !== p.id && q.ws.readyState === 1) q.ws.send(out);
      return;
    }
    default:
      return send(p, { t: "error", req, code: "unknown_type" });
  }
}
function onBinary(p: Player, data: Buffer) {
  const r = p.room;
  if (!r) return;
  const out = Buffer.allocUnsafe(4 + data.length);
  out.writeUInt32BE(p.id, 0);
  data.copy(out, 4);
  for (const [id, q] of r.players) if (id !== p.id && q.ws.readyState === 1) q.ws.send(out, { binary: true });
}
const toBuffer = (d: RawData): Buffer => Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d as ArrayBuffer);

function onConnection(ws: WebSocket, appId: string, who: string) {
  const p: Player = { id: nextPlayerId++, name: "", ws, appId, who, room: null, tokens: LIMITS.rateBurst, tokensAt: Date.now(), throttledAt: 0, alive: true };
  p.name = "player-" + p.id;
  players.add(p);
  send(p, { t: "welcome", you: p.id, name: p.name, app: appId });
  ws.on("pong", () => { p.alive = true; });
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!allow(p)) return;
    if (isBinary) onBinary(p, toBuffer(data)); else onText(p, toBuffer(data).toString("utf8"));
  });
  ws.on("close", () => { players.delete(p); appState(appId).lobby.delete(p); leaveRoom(p); });
  ws.on("error", () => {});
}

// ---- http ----
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function parsePath(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://local");
  let path = url.pathname;
  let viaAccess = false;
  if (path === "/access" || path.startsWith("/access/")) { viaAccess = true; path = path.slice("/access".length) || "/"; }
  return { url, path, viaAccess };
}
function cors(req: IncomingMessage, res: ServerResponse, viaAccess: boolean) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (viaAccess) {
    if (!allowedOrigins().includes(origin)) return;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-app-key, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}
const APP_ID = "([a-z0-9][a-z0-9-]{0,40})";
const ROOMS_RE = new RegExp("^/v1/apps/" + APP_ID + "/rooms$");
const WS_RE = new RegExp("^/v1/apps/" + APP_ID + "/ws$");

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const { url, path, viaAccess } = parsePath(req);
  cors(req, res, viaAccess);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  if (path === "/healthz") return json(res, 200, { ok: true });
  if (path === "/sdk.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    return res.end(readFileSync(SDK_PATH));
  }
  if (path === "/") return json(res, 200, { service: "gamehub", endpoints: ["GET /v1/apps", "GET /v1/apps/{app}/rooms", "WS /v1/apps/{app}/ws", "GET /sdk.js"], access: "prefix /access for Cloudflare Access apps" });
  if (path === "/v1/apps") {
    const cfg = loadConfig();
    return json(res, 200, { apps: Object.entries(cfg.apps).map(([id, a]) => ({ id, name: a.name ?? id, access: a.access })) });
  }
  const m = ROOMS_RE.exec(path);
  if (m) {
    const a = await authorize(req, m[1], viaAccess, url);
    if (!a.ok) return json(res, a.status, { error: a.code });
    return json(res, 200, { rooms: listRooms(m[1]) });
  }
  return json(res, 404, { error: "not_found" });
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((e) => { log("http error:", (e as Error).message); if (!res.headersSent) json(res, 500, { error: "internal" }); });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload });
server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const reject = (status: number, code: string) => {
    socket.write("HTTP/1.1 " + status + " " + code + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  };
  (async () => {
    const { url, path, viaAccess } = parsePath(req);
    const m = WS_RE.exec(path);
    if (!m) return reject(404, "not_found");
    if (players.size >= LIMITS.maxConnections) return reject(503, "busy");
    const a = await authorize(req, m[1], viaAccess, url);
    if (!a.ok) return reject(a.status, a.code);
    if (a.app.access === "cloudflare") {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins(a.app).includes(origin)) return reject(403, "bad_origin");
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, m[1], a.who));
  })().catch((e) => { log("upgrade error:", (e as Error).message); reject(500, "internal"); });
});

setInterval(() => {
  for (const p of players) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    p.ws.ping();
  }
}, LIMITS.heartbeatMs).unref();
setInterval(() => {
  const now = Date.now();
  for (const [appId, st] of appStates)
    for (const [id, r] of st.rooms)
      if (r.emptySince !== null && now - r.emptySince > LIMITS.emptyRoomTtlMs) { st.rooms.delete(id); log("room expired", appId, id); }
}, 10_000).unref();

process.on("SIGHUP", () => { configMtime = -1; badMtime = -1; loadConfig(); });
process.on("SIGTERM", () => {
  for (const p of players) p.ws.close(1001, "server restart");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
loadConfig();
server.listen(PORT, HOST, () => log("gamehub listening on", HOST + ":" + PORT));

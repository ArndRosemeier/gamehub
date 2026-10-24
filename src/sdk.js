// GameHub client SDK - plain ES module, no build step. Works in browsers and Node >= 22.
//
//   import { connect } from "https://games.futuremagic.de/sdk.js";
//   const hub = connect({ app: "tank", appKey: "...", name: "Arnd" });   // key-mode app
//   const hub = connect({ app: "secret-game", access: true });           // Cloudflare Access app
//   await hub.ready;
//   hub.watchLobby((rooms) => render(rooms));
//   await hub.create({ name: "Duel", maxPlayers: 2, meta: { mode: "duel" } });
//   hub.on("state", (snapshot) => world = snapshot);
//   hub.on("delta", (delta) => apply(world, delta));
//   if (hub.isHost) { hub.setState(world); hub.sendDelta({ move: [3, 4] }); }
export function connect(options = {}) {
  const { url = "https://games.futuremagic.de", app, appKey, access = false, name } = options;
  if (!app) throw new Error("gamehub: options.app is required");
  const base = url.replace(/\/+$/, "") + (access ? "/access" : "");
  const httpBase = base.replace(/^ws/, "http");
  const wsBase = base.replace(/^http/, "ws");
  const appPath = "/v1/apps/" + encodeURIComponent(app);
  const query = appKey ? "?key=" + encodeURIComponent(appKey) : "";

  const handlers = new Map();
  const pending = new Map();
  const lobbyRooms = new Map();
  const st = { you: null, host: null, room: null, players: new Map() };
  let reqSeq = 0;
  let readyDone = false;
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});

  const emit = (ev, ...args) => {
    for (const fn of handlers.get(ev) ?? []) { try { fn(...args); } catch (e) { console.error("gamehub handler error:", e); } }
  };
  const ws = new WebSocket(wsBase + appPath + "/ws" + query);
  ws.binaryType = "arraybuffer";
  const raw = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const request = (msg) => new Promise((resolve, reject) => {
    const req = ++reqSeq;
    pending.set(req, { resolve, reject });
    raw({ ...msg, req });
  });

  ws.onopen = () => { if (name) raw({ t: "hello", name }); };
  ws.onerror = (e) => emit("error", { code: "socket_error", event: e });
  ws.onclose = (e) => {
    if (!readyDone) { readyDone = true; rejectReady(new Error("gamehub: could not connect (" + e.code + ")")); }
    for (const p of pending.values()) p.reject(new Error("gamehub: connection closed"));
    pending.clear();
    emit("close", e);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      const buf = new Uint8Array(ev.data);
      const from = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
      return emit("binary", buf.subarray(4), from);
    }
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.t) {
      case "welcome":
        st.you = m.you;
        if (!readyDone) { readyDone = true; resolveReady({ you: m.you, name: m.name }); }
        break;
      case "joined":
        st.room = m.room; st.host = m.host;
        st.players = new Map(m.players.map((x) => [x.id, x]));
        emit("joined", m.room, { you: m.you, host: m.host, players: m.players });
        if (m.state.snapshot !== null) emit("state", m.state.snapshot, m.state.snapshotSeq);
        for (const d of m.state.deltas) emit("delta", d.data, d.seq);
        if (m.state.complete === false) emit("incomplete");
        break;
      case "state": emit("state", m.data, m.seq); break;
      case "delta": emit("delta", m.data, m.seq); break;
      case "msg": emit("msg", m.data, m.from); break;
      case "player+": st.players.set(m.player.id, m.player); emit("player+", m.player); break;
      case "player-": st.players.delete(m.id); emit("player-", m.id); break;
      case "host": st.host = m.id; emit("host", m.id); break;
      case "room": st.room = m.room; emit("room", m.room); break;
      case "rooms":
        lobbyRooms.clear();
        for (const r of m.rooms) lobbyRooms.set(r.id, r);
        emit("lobby", [...lobbyRooms.values()]);
        break;
      case "room+": lobbyRooms.set(m.room.id, m.room); emit("lobby", [...lobbyRooms.values()]); break;
      case "room-": lobbyRooms.delete(m.id); emit("lobby", [...lobbyRooms.values()]); break;
      case "left": st.room = null; st.host = null; st.players.clear(); break;
      case "need-snapshot": emit("need-snapshot"); break;
      case "error": emit("error", m); break;
    }
    if (m.req !== undefined && pending.has(m.req)) {
      const p = pending.get(m.req);
      pending.delete(m.req);
      if (m.t === "error") p.reject(Object.assign(new Error("gamehub: " + m.code), { code: m.code }));
      else p.resolve(m);
    }
  };

  return {
    ready,
    get you() { return st.you; },
    get host() { return st.host; },
    get isHost() { return st.you !== null && st.you === st.host; },
    get room() { return st.room; },
    get players() { return [...st.players.values()]; },
    /** Subscribe to an event; returns an unsubscribe function.
     *  Events: state, delta, msg, binary, joined, player+, player-, host, room, lobby,
     *          need-snapshot (host: please call setState), incomplete, error, close */
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
      return () => handlers.get(ev)?.delete(fn);
    },
    /** Public rooms of this app over plain HTTP - no socket needed. */
    async listRooms() {
      const headers = {};
      if (appKey) headers["x-app-key"] = appKey;
      const r = await fetch(httpBase + appPath + "/rooms", { headers, credentials: access ? "include" : "omit" });
      if (!r.ok) throw new Error("gamehub: rooms HTTP " + r.status);
      return (await r.json()).rooms;
    },
    /** Live lobby: calls onRooms(rooms) now and on every change. Returns a stop function. */
    watchLobby(onRooms) {
      const off = this.on("lobby", onRooms);
      raw({ t: "lobby", on: true });
      return () => { off(); raw({ t: "lobby", on: false }); };
    },
    create(room = {}) { return request({ t: "create", room }).then((m) => m.room); },
    join(roomId) { return request({ t: "join", id: roomId }).then((m) => m.room); },
    leave() { return request({ t: "leave" }); },
    /** Host only: replace the full state (late joiners start from the latest one). */
    setState(data) { raw({ t: "state", data }); },
    /** Host only: incremental change, applied in order after the latest state. */
    sendDelta(data) { raw({ t: "delta", data }); },
    /** Any player: free-form message to everyone else, or to one player id (e.g. inputs to the host). */
    send(data, to) { raw(to === undefined ? { t: "msg", data } : { t: "msg", data, to }); },
    /** Any player: raw bytes to everyone else in the room; receivers get ("binary", bytes, fromId). */
    sendBinary(bytes) { if (ws.readyState === 1) ws.send(bytes); },
    /** Host only: rename, show/hide in the lobby, or change room metadata. */
    setRoom(changes = {}) {
      const m = { t: "meta" };
      if (changes.name !== undefined) m.name = changes.name;
      if (changes.public !== undefined) m.public = changes.public;
      if (changes.meta !== undefined) m.meta = changes.meta;
      raw(m);
    },
    close() { ws.close(1000); },
  };
}

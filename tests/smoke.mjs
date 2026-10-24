// End-to-end smoke test through the real SDK against a running server.
//   GH_URL=http://127.0.0.1:8490 GH_KEY_FILE=/tmp/gh-demo.key node tests/smoke.mjs
import { readFileSync } from "node:fs";
import { connect } from "../src/sdk.js";

const url = process.env.GH_URL ?? "http://127.0.0.1:8490";
const appKey = readFileSync(process.env.GH_KEY_FILE ?? "/tmp/gh-demo.key", "utf8").trim();
const app = "demo";
let failures = 0;
const ok = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function next(client, ev, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error("timeout waiting for " + ev)); }, ms);
    const off = client.on(ev, (...a) => { if (pred(...a)) { clearTimeout(t); off(); resolve(a); } });
  });
}
const join = (name) => { const c = connect({ url, app, appKey, name }); return c.ready.then(() => c); };

try {
  // 1. auth
  const bad = connect({ url, app, appKey: "ghk_demo_wrong" });
  ok(await bad.ready.then(() => false, () => true), "wrong app key is refused");

  // 2. host creates a public room
  const A = await join("Alice");
  const room = await A.create({ name: "Smoke duel", maxPlayers: 3, meta: { mode: "duel", map: "dunes" } });
  ok(/^[A-Z2-9]{6}$/.test(room.id) && A.isHost, "host creates room " + room.id + " and is host");

  // 3. discovery: HTTP list + live lobby
  const L = await join("Lurker");
  const listed = await L.listRooms();
  ok(listed.some((r) => r.id === room.id && r.meta.mode === "duel"), "HTTP room list shows the public room with meta");
  const lobbyFirst = next(L, "lobby");
  const stopLobby = L.watchLobby(() => {});
  const [rooms0] = await lobbyFirst;
  ok(rooms0.some((r) => r.id === room.id), "live lobby delivers the current rooms");

  // 4. state + deltas, then a late joiner reconstructs them in order
  A.setState({ tick: 0, units: ["a"] });
  A.sendDelta({ tick: 1 });
  A.sendDelta({ tick: 2 });
  await sleep(150);
  const C = connect({ url, app, appKey, name: "Carol" });
  const got = [];
  C.on("state", (s, seq) => got.push(["state", s.tick, seq]));
  C.on("delta", (d, seq) => got.push(["delta", d.tick, seq]));
  await C.ready;
  const lobbyUpd = next(L, "lobby", (rs) => rs.some((r) => r.id === room.id && r.players === 2));
  const playerJoined = next(A, "player+", (p) => p.name === "Carol");
  await C.join(room.id);
  ok(JSON.stringify(got) === JSON.stringify([["state", 0, 1], ["delta", 1, 2], ["delta", 2, 3]]), "late joiner gets snapshot then deltas in order " + JSON.stringify(got));
  ok((await playerJoined)[0].name === "Carol", "host sees the new player (presence)");
  ok(!!(await lobbyUpd), "lobby watcher sees the player count change");
  stopLobby();

  // 5. live delta reaches a joined player
  const liveDelta = next(C, "delta", (d) => d.tick === 3);
  A.sendDelta({ tick: 3 });
  ok((await liveDelta)[1] === 4, "live delta arrives with seq 4");

  // 6. player -> host message (intents)
  const intent = next(A, "msg");
  C.send({ input: "fire" }, A.you);
  const [msgData, fromId] = await intent;
  ok(msgData.input === "fire" && fromId === C.you, "player intent reaches the host with sender id");

  // 7. binary relay, sender id prefixed
  const bin = next(C, "binary");
  A.sendBinary(new Uint8Array([7, 8, 9]));
  const [bytes, binFrom] = await bin;
  ok(binFrom === A.you && [...bytes].join() === "7,8,9", "binary frame relayed with sender id");

  // 8. only the host may publish state
  const denied = next(C, "error", (e) => e.code === "not_host");
  C.sendDelta({ cheat: true });
  ok(!!(await denied), "non-host delta is refused (not_host)");

  // 9. room capacity
  const D = await join("Dave");
  await D.join(room.id);
  const E = await join("Eve");
  ok(await E.join(room.id).then(() => false, (e) => e.code === "room_full"), "4th player refused: room_full (maxPlayers 3)");

  // 10. private room: joinable by code, hidden from the lobby
  const priv = await E.create({ name: "Secret", public: false });
  const visible = (await L.listRooms()).some((r) => r.id === priv.id);
  ok(!visible, "private room is not listed");
  const F = await join("Frank");
  ok(await F.join(priv.id.toLowerCase()).then(() => true, () => false), "private room joinable by code (case-insensitive)");

  // 11. host migration
  const newHost = next(C, "host");
  A.close();
  const [hostId] = await newHost;
  ok(hostId === C.you && C.isHost, "host leaves -> earliest remaining player becomes host");

  // 12. new host keeps the room going
  const afterMigration = next(D, "delta", (d) => d.tick === 4);
  C.sendDelta({ tick: 4 });
  ok(!!(await afterMigration), "new host can publish deltas");

  // 13. rate limiting
  const limited = next(F, "error", (e) => e.code === "rate_limited", 4000);
  for (let i = 0; i < 300; i++) F.send({ spam: i });
  ok(!!(await limited), "flooding client is rate-limited");

  for (const c of [bad, L, C, D, E, F]) c.close();
} catch (e) {
  console.log("FAIL exception: " + e.message);
  failures++;
}
console.log(failures === 0 ? "ALL PASS" : failures + " FAILURE(S)");
process.exit(failures ? 1 : 0);

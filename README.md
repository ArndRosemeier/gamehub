# GameHub

Universal, in-memory game-state relay for TypeScript games — **https://games.futuremagic.de**.
No per-game server code: apps own rooms, a room's **host** publishes the game state (snapshot + deltas),
everyone else receives it. Nothing is stored on disk; empty rooms expire after 60 s.

## Use it from a game

```ts
import { connect } from "https://games.futuremagic.de/sdk.js";

const hub = connect({ app: "tank", appKey: "ghk_tank_…", name: "Arnd" }); // key-mode app
// const hub = connect({ app: "secret", access: true });                  // Cloudflare-Access app
await hub.ready;

hub.watchLobby((rooms) => renderLobby(rooms));          // live list of public rooms
await hub.create({ name: "Duel", maxPlayers: 2, meta: { mode: "duel" } });  // or: await hub.join("K7Q2ZP")

hub.on("state", (snapshot) => { world = snapshot; });   // full state (also replayed to late joiners)
hub.on("delta", (delta) => apply(world, delta));        // in order, after the latest state
hub.on("msg", (data, from) => { if (hub.isHost) handleInput(from, data); });
hub.on("need-snapshot", () => hub.setState(world));     // server asks the host to compact history
hub.on("host", (id) => { /* host migrated; if id === hub.you you now run the simulation */ });

if (hub.isHost) { hub.setState(world); hub.sendDelta({ move: [3, 4] }); }
else hub.send({ input: "fire" }, hub.host);            // intents go to the host
hub.sendBinary(new Uint8Array([…]));                    // raw bytes; receivers get ("binary", bytes, fromId)
```

Model: **host-authoritative relay**. The server reads only the envelope, never your state — fast and
game-agnostic, but it trusts the host. Server-side authority can be added per game later.

## Access, per app

| mode | how a game connects |
|---|---|
| `key` | public endpoint, the game presents an app key (`appKey` → `?key=` on the socket, `x-app-key` over HTTP) |
| `cloudflare` | through `/access/…`, which Cloudflare Access protects; the server verifies the Access JWT (RS256, team JWKS, AUD) |

```bash
cd ~/projects/GameHub
npm run apps -- add tank --name "Tank" --access key --max-players 8
npm run apps -- mint-key tank             # prints the key ONCE; only its sha256 is stored
npm run apps -- add secret --access cloudflare
npm run apps -- access-config --aud <AUD tag of the Access application>
npm run apps -- list
```
Config: `~/gamehub-config/apps.json` (outside the repo, mode 600). The server re-reads it on change — no restart.

## HTTP
- `GET /healthz` · `GET /sdk.js` · `GET /v1/apps` (ids, names, access mode)
- `GET /v1/apps/{app}/rooms` — public, non-empty rooms (auth per app)
- `WS  /v1/apps/{app}/ws` — the game socket. Prefix both with `/access` for cloudflare-mode apps.

## Wire protocol (text frames, JSON)
client → server: `hello{name}`, `lobby{on}`, `create{room:{name,public,maxPlayers,meta}}`, `join{id}`, `leave`,
`state{data}` / `delta{data}` / `meta{name,public,meta}` (host only), `msg{data,to?}`. Add `req` to get it echoed.
server → client: `welcome`, `joined{room,you,host,players,state:{seq,snapshotSeq,snapshot,deltas,complete}}`,
`state{seq,data}`, `delta{seq,data}`, `msg{from,data}`, `player+`, `player-`, `host{id}`, `room`, `rooms`,
`room+`, `room-`, `need-snapshot`, `error{code}`. Binary frames are relayed to the room as `[u32 senderId][payload]`.

## Limits (src/server.ts `LIMITS`)
1 MiB per message · 60 msg/s per socket (burst 120) · 500 sockets · per app: `maxRooms` (100), `maxPlayersPerRoom` (16) ·
delta history 1000 entries / 4 MiB, then the host is asked for a fresh snapshot.

## Operate
- unit: `systemctl --user status gamehub` (loopback 127.0.0.1:8490, `MemoryMax=512M`) · logs: `journalctl --user -u gamehub`
- tunnel: `games.futuremagic.de → http://127.0.0.1:8490` in `/etc/cloudflared/config.yml`
- test: `GH_URL=https://games.futuremagic.de GH_KEY_FILE=~/gamehub-config/demo.key npm run smoke`
  (on this box add `NO_PROXY=games.futuremagic.de,127.0.0.1`: the OpenClaw egress proxy otherwise captures Node's WebSocket)

## This deployment's frontend

`src/web/` holds the built **lobby** (from `gameserver@311127c`, built with the default relative registry).
Served at `https://games.futuremagic.de/`. Because the lobby reads the site registry same-origin, the relay
proxies two paths from the apps host: `GET /apps.json` and `GET /shots/*` (in-memory cache, 60 s / 600 s).
The JSON service index lives at `/v1`.

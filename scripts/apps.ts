// GameHub app management. The server re-reads the config on change - no restart needed.
//   node --experimental-strip-types scripts/apps.ts list
//   node --experimental-strip-types scripts/apps.ts add <id> [--name N] [--access key|cloudflare] [--max-rooms N] [--max-players N]
//   node --experimental-strip-types scripts/apps.ts mint-key <id>        prints a new app key ONCE (only its sha256 is stored)
//   node --experimental-strip-types scripts/apps.ts revoke-keys <id>
//   node --experimental-strip-types scripts/apps.ts set-access <id> key|cloudflare
//   node --experimental-strip-types scripts/apps.ts remove <id>
//   node --experimental-strip-types scripts/apps.ts access-config --team <team.cloudflareaccess.com> --aud <AUD tag>
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CONFIG_PATH = process.env.GAMEHUB_CONFIG ?? "/home/administrator/gamehub-config/apps.json";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

function fail(msg: string): never { console.error(msg); process.exit(2); }
function load(): any { return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : { apps: {} }; }
function save(c: any) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}
const [cmd, id, ...rest] = process.argv.slice(2);
const opt = (n: string) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : undefined; };
const optAll = (n: string) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : undefined; };
const c = load();
c.apps ??= {};
function needApp(appId: string | undefined) { if (!appId || !c.apps[appId]) fail("no such app: " + appId); return c.apps[appId]; }

switch (cmd) {
  case "list":
    for (const [k, a] of Object.entries<any>(c.apps)) console.log([k, a.access, a.name ?? k, "keys=" + (a.keyHashes ?? []).length, "maxRooms=" + (a.maxRooms ?? 100), "maxPlayers=" + (a.maxPlayersPerRoom ?? 16)].join("\t"));
    if (c.cloudflare) console.log("access: team=" + (c.cloudflare.teamDomain ?? "-") + " aud=" + (c.cloudflare.aud ? "set" : "-"));
    break;
  case "add": {
    if (!id || !ID_RE.test(id)) fail("usage: add <id: a-z0-9-> [--name N] [--access key|cloudflare] [--max-rooms N] [--max-players N]");
    if (c.apps[id]) fail("app exists: " + id);
    const access = opt("access") ?? "key";
    if (access !== "key" && access !== "cloudflare") fail("--access must be key or cloudflare");
    c.apps[id] = { name: opt("name") ?? id, access, keyHashes: [], maxRooms: Number(opt("max-rooms") ?? 100), maxPlayersPerRoom: Number(opt("max-players") ?? 16) };
    save(c);
    console.log("added " + id + " (" + access + ")");
    break;
  }
  case "mint-key": {
    const a = needApp(id);
    if (a.access !== "key") fail(id + " uses " + a.access + " access - it needs no key");
    const minted = "ghk_" + id + "_" + randomBytes(24).toString("base64url");
    a.keyHashes = [...(a.keyHashes ?? []), createHash("sha256").update(minted).digest("hex")];
    save(c);
    console.log(minted);
    break;
  }
  case "add-key": {
    // Register a key that already ships in a game's bundle, so its build keeps working.
    const a = needApp(id);
    if (a.access !== "key") fail(id + " uses " + a.access + " access - it needs no key");
    const presented = (rest[0] ?? readFileSync(0, "utf8")).trim();
    if (!presented) fail("usage: add-key <id> [key]   (or pipe the key on stdin)");
    const hash = createHash("sha256").update(presented).digest("hex");
    a.keyHashes = [...new Set([...(a.keyHashes ?? []), hash])];
    save(c);
    console.log("registered an existing key for " + id + " (keys now " + a.keyHashes.length + ")");
    break;
  }
  case "revoke-keys": { const a = needApp(id); a.keyHashes = []; save(c); console.log("revoked all keys of " + id); break; }
  case "set-access": {
    const a = needApp(id);
    const mode = rest[0];
    if (mode !== "key" && mode !== "cloudflare") fail("usage: set-access <id> key|cloudflare");
    a.access = mode; save(c); console.log(id + " now uses " + mode + " access");
    break;
  }
  case "remove": { needApp(id); delete c.apps[id]; save(c); console.log("removed " + id); break; }
  case "access-config": {
    const team = optAll("team"), aud = optAll("aud");
    if (!team && !aud) fail("usage: access-config --team <team.cloudflareaccess.com> --aud <AUD tag>");
    c.cloudflare ??= {};
    if (team) c.cloudflare.teamDomain = team;
    if (aud) c.cloudflare.aud = aud;
    save(c); console.log("access config updated");
    break;
  }
  default:
    fail("commands: list | add | mint-key | revoke-keys | set-access | remove | access-config");
}

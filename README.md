# MapleScouter Cloud

Tiny cloud-save backend for the [MapleScouter Enhancements](https://github.com/tomerh2001/maplescouter-en-fix) userscript and extension.
It stores Character page presets from [maplescouter.com](https://maplescouter.com), keyed by IGN, so a character can be synced between browsers and devices.

Live instance: `https://scouter.tomerh2001.com`

## How it works

- One JSON document per character, keyed by the IGN lowercased.
- No accounts and no tokens. **Anyone can read or overwrite any IGN.** It is a convenience sync, not a vault.
- File-backed store: `DATA_DIR/characters/<ign>.json`, written atomically (temp file + fsync + rename). No database.
- In-memory index rebuilt from the directory on boot; list and `HEAD` never touch the disk.
- Optimistic concurrency via `ETag` / `If-Match`.
- A small avatar route proxies Nexon's public GMS ranking API (the browser cannot call it directly) and caches the result.
- Node 20, TypeScript, Fastify 5, pino JSON logs on stdout.

## API

Base URL: `https://scouter.tomerh2001.com`. Every response is JSON. CORS is open (`Access-Control-Allow-Origin: *`).

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| `GET` | `/healthz` | Liveness + character count | `{ "ok": true, "characters": N }` |
| `GET` | `/v1/characters` | List summaries, newest first | Cap 500, optional `?limit=N` |
| `GET` | `/v1/characters/:ign` | Full document | `ETag: "<updatedAt>"`, honours `If-None-Match` (304) |
| `HEAD` | `/v1/characters/:ign` | Headers only | Cheap sync polling; same `ETag` |
| `PUT` | `/v1/characters/:ign` | Create or replace | Body `{ preset, label?, meta? }`; optional `If-Match`; `201` created / `200` updated |
| `DELETE` | `/v1/characters/:ign` | Delete | Requires header `X-Confirm: <ign>`; returns `204` |
| `GET` | `/v1/avatar/:ign` | Character look from the GMS rankings | Image URL, level, job, world; cached, `Cache-Control: public, max-age=3600` |

### IGN rules

- Must match `^[A-Za-z0-9]{1,16}$`.
- Lookups are case-insensitive (`HTomer` and `htomer` are the same character).
- The display case of the most recent `PUT` is kept in `ign`.

### Document

```json
{
  "ign": "HTomer",
  "label": "HTomer",
  "createdAt": "2026-09-01T12:00:00.000Z",
  "updatedAt": "2026-09-03T08:15:42.117Z",
  "meta": { "class": "은월", "level": 290, "hexaStat": 2 },
  "preset": {
    "type": "maplescouter-manual-preset",
    "v": 1,
    "savedAt": "2026-09-03T08:15:41.000Z",
    "label": "HTomer",
    "data": { "stat": { "myClass": "은월", "level": "290" }, "hexa": { "hexaStat": 2 }, "doping": {}, "linkSkill": {} }
  }
}
```

`meta` is derived on the server from `preset.data.stat.myClass`, `preset.data.stat.level` and `preset.data.hexa.hexaStat`.
A client-sent `meta` only fills gaps (for example `hexaStat` when the preset has none). `hexaStat` is `null` when unknown.

### PUT body

```json
{ "preset": { "type": "maplescouter-manual-preset", "v": 1, "savedAt": "...", "label": "...", "data": { } }, "label": "optional", "meta": { "hexaStat": 2 } }
```

Validation:

- `preset.type` must be `maplescouter-manual-preset`, `preset.v` must be `1`.
- `preset.data` must be an object containing `stat`, `hexa`, `doping`, `linkSkill` objects.
- `preset.data.stat.myClass`: non-empty string. `preset.data.stat.level`: integer 0..300 (numeric string or number).
- `label`: optional string, trimmed, max 64 chars. Defaults to the IGN.
- Body limit 256 KB. Unknown keys inside the `preset` envelope are dropped; `preset.data` is stored verbatim.

Concurrency: send `If-Match: "<updatedAt>"` (the `ETag` you last saw). If the stored `updatedAt` differs you get `409 { "error": "conflict", "updatedAt": "<current or null>" }` and nothing is written.

### Avatar: `GET /v1/avatar/:ign`

Looks the IGN up on Nexon's public GMS ranking API (`.../ranking/v2/na`, overall weekly board, regular worlds first, then Heroic worlds) and returns the character's current look. Nexon sends no CORS headers, so the extension cannot ask Nexon from maplescouter.com; this route proxies it. It has nothing to do with the stored presets: an IGN can have an avatar and no document, or the other way round.

```json
{
  "ign": "HTomer",
  "level": 291,
  "job": "Shade",
  "worldId": 1,
  "image": "https://msavatar1.nexon.net/Character/....png",
  "fetchedAt": "2026-09-03T22:29:57.013Z"
}
```

- `ign` is spelled the way Nexon has it. `image` is a 96x96 PNG served by Nexon (no CSP on maplescouter.com, so `<img src>` works).
- `404 { "error": "not_found" }` when the character is on neither board. `502 { "error": "upstream" }` when Nexon fails and nothing is cached.
- Cache: in memory, keyed by the lowercase IGN. Hits are reused for 24 h, misses for 1 h (`AVATAR_HIT_TTL_MS`, `AVATAR_MISS_TTL_MS`). Hits are written to `DATA_DIR/avatars.json` (atomic temp file + rename) and loaded on boot, so a restart does not refetch. If Nexon fails while an expired hit is cached, the stale hit is served. Expired hits are kept for that purpose for 7 days, then dropped from memory and from the file. At most 20 000 entries; the oldest are dropped.
- Concurrent requests for one IGN share a single upstream call. Each upstream call has an 8 s timeout and sends the User-Agent `Mozilla/5.0 (compatible; maplescouter-cloud/1.0; +https://github.com/tomerh2001/maplescouter-cloud)`.
- `200` and `404` carry `Cache-Control: public, max-age=3600` (every other route is `no-store`). Counted by the read rate limit.

### Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_ign` | IGN fails the regex |
| 400 | `invalid_body` | Validation failed (`detail` says why) |
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `confirm_required` | `DELETE` without a matching `X-Confirm` |
| 404 | `not_found` | Unknown character or route |
| 409 | `conflict` | `If-Match` mismatch (`updatedAt` = current value, or `null`) |
| 413 | `payload_too_large` | Body over 256 KB |
| 415 | `unsupported_media_type` | Missing `Content-Type: application/json` |
| 429 | `rate_limited` | See below; `Retry-After` header is set |
| 502 | `upstream` | `GET /v1/avatar/:ign` only: Nexon did not answer and there is no cached look for that IGN |
| 507 | `storage_full` | The store holds `MAX_CHARACTERS` characters and this IGN is new. Overwriting an existing IGN still works |

### Rate limits (hygiene, not auth)

- Reads (`GET`/`HEAD`): 600 per minute per IP, shared across read endpoints.
- Writes (`PUT`, `DELETE`): 60 per minute per IP, per endpoint.
- `/healthz`, `/` and CORS preflights are never limited.
- The client IP is `CF-Connecting-IP` (set by the Cloudflare edge) when the header is present and `TRUST_PROXY` and `TRUST_CF_HEADER` are both on (the defaults). Otherwise it is the last `X-Forwarded-For` hop with `TRUST_PROXY=true`, or the socket address with `TRUST_PROXY=false`.

### curl examples

```bash
BASE=https://scouter.tomerh2001.com

# health
curl -s "$BASE/healthz"

# upload / replace a character (preset.json is a file exported by maplescouter.com's Save-as-JSON)
curl -s -X PUT "$BASE/v1/characters/HTomer" \
  -H 'Content-Type: application/json' \
  -d "{\"preset\": $(cat preset.json), \"label\": \"HTomer\"}"

# fetch it (note the ETag)
curl -si "$BASE/v1/characters/HTomer"

# cheap change check
curl -sI "$BASE/v1/characters/HTomer"

# conditional replace: only if nobody else wrote since
curl -s -X PUT "$BASE/v1/characters/HTomer" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "2026-09-03T08:15:42.117Z"' \
  -d "{\"preset\": $(cat preset.json)}"

# list everyone
curl -s "$BASE/v1/characters"

# character look (image URL, level, job, world) from the GMS rankings
curl -s "$BASE/v1/avatar/HTomer"

# delete (must confirm with the IGN)
curl -s -X DELETE "$BASE/v1/characters/HTomer" -H 'X-Confirm: HTomer' -o /dev/null -w '%{http_code}\n'

# CORS preflight as the browser would send it
curl -si -X OPTIONS "$BASE/v1/characters/HTomer" \
  -H 'Origin: https://maplescouter.com' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type,if-match'
```

## Configuration

All via environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `/data` | Store root; documents live in `DATA_DIR/characters/`, the avatar cache in `DATA_DIR/avatars.json` |
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | `false` | Human-readable logs (dev only; needs `pino-pretty`) |
| `TRUST_PROXY` | `true` | Trust one proxy hop (traefik) for `X-Forwarded-*`. With `false` no forwarding header is read at all and the socket address is the client |
| `TRUST_CF_HEADER` | `true` | Key the rate limiter on `CF-Connecting-IP` (set by the Cloudflare edge) when present, else fall back to the address above. Only used when `TRUST_PROXY=true`. Turn it off if traefik is reachable without Cloudflare in front, otherwise a client can forge the header and get a fresh bucket per request |
| `BODY_LIMIT` | `262144` | Max request body in bytes |
| `READ_RATE_LIMIT` | `600` | Reads per minute per IP |
| `WRITE_RATE_LIMIT` | `60` | Writes per minute per IP, per endpoint |
| `MAX_CHARACTERS` | `20000` | Max stored characters. New IGNs past this get `507`, so one client cannot fill the disk |
| `AVATAR_HIT_TTL_MS` | `86400000` | How long a found avatar is reused before asking Nexon again (24 h) |
| `AVATAR_MISS_TTL_MS` | `3600000` | How long a "not found" avatar answer is reused (1 h) |
| `AVATAR_UPSTREAM` | `https://www.nexon.com/api/maplestory/no-auth/ranking/v2/na` | Ranking API base URL the avatar route proxies. Only worth changing to point at a stub |

## Development

```bash
npm ci
npm test          # vitest: store unit tests + route tests via fastify.inject (the avatar route runs against a stubbed fetch, no network)
npm run build     # tsc -> dist/
npm run dev       # build, then serve on :8080 with DATA_DIR=./tmp/data and pretty logs
```

Layout:

- `src/store.ts`: file-backed atomic store + in-memory index.
- `src/validate.ts`: IGN / preset / body validation and `meta` derivation.
- `src/avatar.ts`: Nexon ranking look-up, avatar cache, `avatars.json` persistence, in-flight dedupe.
- `src/app.ts`: Fastify app (routes, CORS, rate limits, error mapping).
- `src/server.ts`: entrypoint with graceful shutdown.
- `test/`: vitest suites.

## Docker

```bash
docker build -t maplescouter-cloud .
docker run --rm -p 8080:8080 -v "$PWD/data:/data" maplescouter-cloud
# or the published image
docker run --rm -p 8080:8080 -v "$PWD/data:/data" ghcr.io/tomerh2001/maplescouter-cloud:latest
```

Image notes:

- Multi-stage `node:20-alpine`, production dependencies only, runs as the non-root `node` user.
- `EXPOSE 8080`, `VOLUME /data`, built-in `HEALTHCHECK` hitting `/healthz`.
- Safe to run with a custom `user:` (for example `PUID:PGID`); just make sure that user owns the `/data` mount.

## CI and image publishing

Workflow: `.github/workflows/publish.yml`.

- Pull requests and pushes to `main`: `npm ci`, `npm test`, `npm run build`.
- Pushes to `main` additionally build a multi-arch image (`linux/amd64`, `linux/arm64`) and push
  `ghcr.io/tomerh2001/maplescouter-cloud:latest` and `:sha-<short7>`.
- Auth is the workflow's `GITHUB_TOKEN` (`permissions: packages: write`).

**One-time step after the first publish:** the GHCR package is created private. Make it public so the server can pull it without credentials:
GitHub profile -> Packages -> `maplescouter-cloud` -> Package settings -> Danger Zone -> Change visibility -> Public.

## Deployment

Runs on the home server as a normal stack:

- traefik router on `scouter.tomerh2001.com`, middlewares `cloudflarewarp` + `crowdsec` (no auth middleware, by design).
- The Cloudflare tunnel must stay the only way to reach that router. `cloudflarewarp` rewrites `X-Forwarded-For` from `CF-Connecting-IP` only for Cloudflare sources, so a LAN client that could reach traefik directly could inject its own `CF-Connecting-IP`. If you ever expose the service another way, set `TRUST_CF_HEADER=false`.
- Env: `PORT=8080`, `DATA_DIR=/data`, `NODE_ENV=production`.
- Volume: `<data dataset>/maplescouter-cloud:/data`; container runs as `PUID:PGID`.
- The image's own healthcheck is used; the stack-level one stays off.
- Cap the container logs. Docker keeps stdout forever by default, so set on the service:
  `logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }`.
  Each request logs one line (method, route pattern, status, duration, client IP). The IGN is not logged.

Verify after deploy:

```bash
curl -s https://scouter.tomerh2001.com/healthz
```

## License

MIT

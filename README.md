# MapleScouter Cloud

Tiny cloud-save backend for the [MapleScouter English Fix](https://github.com/tomerh2001/maplescouter-en-fix) userscript.
It stores Manual Input presets from [maplescouter.com](https://maplescouter.com), keyed by IGN, so a character can be synced between browsers and devices.

Live instance: `https://scouter.tomerh2001.com`

## How it works

- One JSON document per character, keyed by the IGN lowercased.
- No accounts and no tokens. **Anyone can read or overwrite any IGN.** It is a convenience sync, not a vault.
- File-backed store: `DATA_DIR/characters/<ign>.json`, written atomically (temp file + fsync + rename). No database.
- In-memory index rebuilt from the directory on boot; list and `HEAD` never touch the disk.
- Optimistic concurrency via `ETag` / `If-Match`.
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

### Rate limits (hygiene, not auth)

- Reads (`GET`/`HEAD`): 600 per minute per IP, shared across read endpoints.
- Writes (`PUT`, `DELETE`): 60 per minute per IP, per endpoint.
- `/healthz`, `/` and CORS preflights are never limited.
- The client IP comes from `X-Forwarded-For` (`TRUST_PROXY=true`, the service sits behind traefik).

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
| `DATA_DIR` | `/data` | Store root; documents live in `DATA_DIR/characters/` |
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | `false` | Human-readable logs (dev only; needs `pino-pretty`) |
| `TRUST_PROXY` | `true` | Trust one proxy hop (traefik) for `X-Forwarded-*`. The rate-limit key is `CF-Connecting-IP` when present (set by the Cloudflare edge), else the last `X-Forwarded-For` hop, else the socket address — so a client cannot dodge the limiter by forging `X-Forwarded-For` |
| `BODY_LIMIT` | `262144` | Max request body in bytes |
| `READ_RATE_LIMIT` | `600` | Reads per minute per IP |
| `WRITE_RATE_LIMIT` | `60` | Writes per minute per IP, per endpoint |

## Development

```bash
npm ci
npm test          # vitest: store unit tests + route tests via fastify.inject
npm run build     # tsc -> dist/
npm run dev       # build, then serve on :8080 with DATA_DIR=./tmp/data and pretty logs
```

Layout:

- `src/store.ts`: file-backed atomic store + in-memory index.
- `src/validate.ts`: IGN / preset / body validation and `meta` derivation.
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
- Env: `PORT=8080`, `DATA_DIR=/data`, `NODE_ENV=production`.
- Volume: `<data dataset>/maplescouter-cloud:/data`; container runs as `PUID:PGID`.
- The image's own healthcheck is used; the stack-level one stays off.

Verify after deploy:

```bash
curl -s https://scouter.tomerh2001.com/healthz
```

## License

MIT

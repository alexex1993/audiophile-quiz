# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A blind listening quiz ("Тест на аудиофила"): a signed-in user hears two 30 s clips of the same excerpt and picks one of four statements — 1 = first is lossless, 2 = second is lossless, 3 = both lossless, 4 = both AAC 128k. Go API + PostgreSQL + vanilla-JS frontend, shipped as Docker Compose. All UI text and API error messages are in Russian.

## Commands

```sh
docker compose up -d --build          # build and run app + Postgres (http://localhost:8080, admin at /admin)
docker compose logs -f app
go build ./... && go vet ./...
go test ./...                         # audio pipeline tests; need ffmpeg/ffprobe on PATH
go test ./internal/audio -run TestProcess/hires -v   # single subtest: cd (16/44.1), hires (24/96), ultra (24/192)
docker compose exec db psql -U audiophile audiophile      # DB shell; also exposed on 127.0.0.1:${DB_PORT:-5432}
```

Config is env-only (`internal/config/config.go`, documented in README): `.env` holds Google OAuth credentials, `ADMIN_EMAILS`, `POSTGRES_PASSWORD`, `BASE_URL`. Google login needs `BASE_URL/auth/google/callback` registered as a redirect URI.

On this Mac, `docker compose build` can fail with `~/.docker/buildx/.lock: permission denied` (root-owned dir); set `BUILDX_CONFIG` to a writable dir or `sudo chown -R $(whoami) ~/.docker`.

## Architecture

- `cmd/server` — wiring: config → `store.Open` → `store.Migrate` → `httpapi.New(...).Handler()`; imports `time/tzdata` because the alpine image has no zoneinfo.
- `internal/store` — all SQL (pgx v5, no ORM). Migrations are numbered files in `internal/store/migrations`, embedded and applied at startup, tracked in `schema_migrations`. Add a new file; never edit an applied one.
- `internal/audio` — ffprobe/ffmpeg via `exec`. Runtime image installs ffmpeg.
- `internal/httpapi` — `net/http` mux with method+path patterns (Go 1.22+). `auth.go` (Google OAuth with state+PKCE cookies, DB-backed sessions storing only the sha256 of the cookie token), `quiz.go`, `admin.go`.
- `web/static` — served from the binary via `go:embed` (`web/embed.go`), so **frontend changes require rebuilding the binary/image**. No bundler: plain scripts sharing globals. `common.js` (`api()`, `h()`, `esc()`, `PlayerGroup`) loads first; `admin.html` loads `stats.js` before `admin.js`. `app.js` is a hash-routed SPA for the quiz.

### Invariants that span files

- **Nothing may reveal which clip is which before an attempt is finished.** Clips are served only via opaque per-question tokens (`/api/audio/{token}`, `token_a`/`token_b` in `attempt_questions`); `serveClip` sends identical headers with zero modtime (no ETag/Last-Modified); both WAVs are produced with `-bitexact` and `-map_metadata -1` and must be byte-identical in size (`audio.Process` fails otherwise); `GetAttempt` hides `correct_answer`/kinds until `finished_at` is set. Known accepted leak: in the both-lossless and both-AAC cases the same file is served twice.
- **Audio pipeline** (`audio.Process`): source → sample-accurate `atrim` → `lossless.wav` (PCM codec chosen to keep original bit depth) → AAC from that same WAV (48 kHz if source > 96 kHz) → decode with `aresample`/`apad`/`atrim` back to the original rate and exact sample count → `encoded.wav`. Lossy sources are rejected. The uploaded source is always deleted (defer in `handleUploadTrack`). Clips live in `DATA_DIR/audio/<random hex>/`.
- **Answer encoding**: answers 1–4 map to `(kind_a, kind_b)` via `answerKinds` in `store/quiz.go`; the correct answer is random per question.
- **Admins** are defined by `ADMIN_EMAILS` (config), not a DB column. `attemptLimit` returns 0 (= unlimited) for admins; the store treats limit 0 as no limit. Regular users get `ATTEMPTS_PER_WEEK` over a rolling 7 days; an unfinished attempt is resumed instead of starting a new one.
- **CSRF**: every non-GET request must carry `X-Requested-With: fetch` (`csrfGuard`); `api()` in `common.js` and the upload XHR set it.
- **Deleting a track** sets `attempt_questions.track_id` to NULL; questions keep a title/artist snapshot so history and stats survive.
- **Stats** (`store/stats.go`, `GET /api/admin/stats?days=&admins=0|1&tz=`) aggregate only finished attempts. `stats.js` draws hand-written SVG/HTML charts. Color convention: `--series` (blue) = actual results, `--chance` (orange) = what pure guessing (p = 1/4) would give.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A blind listening quiz ("Тест на аудиофила"): a signed-in user hears two 30 s clips of the same excerpt and picks one of four statements — 1 = first is lossless, 2 = second is lossless, 3 = both lossless, 4 = both AAC. Before starting, the user picks a difficulty = AAC bitrate of the compressed clips and number of tracks (easy 32k × 5, medium 128k × 12, hard 320k × 12). Go API + PostgreSQL + vanilla-JS frontend, shipped as Docker Compose. UI text and API error messages exist in Russian and English (see i18n below).

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

- **Nothing may reveal which clip is which before an attempt is finished.** Clips are served only via opaque per-question tokens (`/api/audio/{token}`, `token_a`/`token_b` in `attempt_questions`); `serveClip` sends identical headers with zero modtime (no ETag/Last-Modified); all FLACs of a track are produced with `-bitexact` and `-map_metadata -1`, and `equalizeFLACSizes` rewrites their PADDING blocks so all four (lossless + one per difficulty) are byte-identical in size (FLAC bitrate depends on content, so the AAC round trip changes it); `PlayerGroup` (`common.js`) downloads both clips in full behind one shared progress bar before either can play, so buffering speed can't hint at the bitrate; `GetAttempt` hides `correct_answer`/kinds until `finished_at` is set. Known accepted leak: in the both-lossless and both-AAC cases the same file is served twice.
- **Audio pipeline** (`audio.Process`): source → sample-accurate `atrim` → `lossless.flac` (re-encoded losslessly, s16 or s32/24-bit to keep original bit depth) → AAC from that same FLAC (48 kHz if source > 96 kHz) → decode with `aresample`/`apad`/`atrim` back to the original rate and exact sample count → `encoded_<bitrate>.flac`, repeated per bitrate in `store.Bitrates()` → pad all to equal size. Lossy, float and >24-bit sources are rejected. Tracks from before difficulties (single `encoded.flac`/`.wav`) were deactivated by migration 002 and must be re-uploaded. The uploaded source is always deleted (defer in `handleUploadTrack`). Clips live in `DATA_DIR/audio/<random hex>/`.
- **Difficulty**: `store.Difficulties` (name → kbps + questions per attempt) is the single source of truth, exposed as `difficulties` in `/api/config` and `/api/me` (`/api/me` caps `questions` by the active track count; there is no global questions-per-quiz setting); names must match the CHECK on `attempts.difficulty`. Chosen per attempt in `POST /api/quiz/start` (`{"difficulty": ...}`, default medium); `AudioByToken` returns the attempt's difficulty so `handleQuizAudio` picks `encoded_<bitrate>.flac`. Changing a bitrate needs no manual step: at startup `Server.SyncClips` re-encodes every track whose `aac_bitrate` differs from the current set (`audio.Reencode`, from its `lossless.flac`; stale `encoded_*.flac` removed, sizes re-equalized, `file_size` updated). Stats don't record kbps per attempt, so a level's history mixes old and new bitrates. The daily quota is shared across levels; resuming an unfinished attempt ignores the requested level. Admin preview: `/api/admin/tracks/{id}/audio/{lossless|easy|medium|hard}`. Easy is framed as a service check only: its result page (`app.js`) shows "just a warm-up" with no praise and offers medium/hard; medium/hard results get a canvas-drawn share image (`drawShareCard`, grade from `hearingGrade`).
- **Answer encoding**: answers 1–4 map to `(kind_a, kind_b)` via `answerKinds` in `store/quiz.go`; the correct answer is random per question.
- **Guests**: `POST /auth/guest` gives a visitor without a session an anonymous user (`users.google_sub` NULL, `email` '', `User.Guest`) and a normal session cookie — no fingerprinting. `requireUser` admits guests; they may only start `store.WarmupDifficulty` (easy; `handleStartQuiz` returns 403 otherwise), never pass `requireAdmin`, and get the regular quota. On Google sign-in, `handleCallback` calls `MergeGuest`: the guest's finished attempts move to the Google user (and count towards its quota), the guest row is deleted. `DeleteExpiredSessions` removes guests with no session and no finished attempt. The frontend shows medium/hard as locked for guests (`guestLocked` in `app.js`), with Google sign-in in place of the start button and on the warm-up result page.
- **Admins** are defined by `ADMIN_EMAILS` (config), not a DB column. `attemptLimit` returns 0 (= unlimited) for admins; the store treats limit 0 as no limit. Regular users get `ATTEMPTS_PER_DAY` over a rolling 24 h (`quotaWindow`); an unfinished attempt is resumed instead of starting a new one. The limit is hidden from players: `/api/config` doesn't expose it and `store.Quota` gives them only `exhausted` + `next_slot` (admins get `unlimited` + `used`).
- **CSRF**: every non-GET request must carry `X-Requested-With: fetch` (`csrfGuard`); `api()` in `common.js` and the upload XHR set it.
- **Deleting a track** sets `attempt_questions.track_id` to NULL; questions keep a title/artist snapshot so history and stats survive.
- **i18n**: language = `lang` cookie (footer switch) if set, else Russian only when the browser's first preference is `ru`, else English — decided identically in `common.js` (`LANG`, from `navigator.languages[0]`) and `httpapi/lang.go` (`isRussian`, from `Accept-Language`). Frontend strings are inline `t("рус", "eng")` pairs (both args are evaluated eagerly; don't shadow `t`), `plural(n, "один|два|пять", "one|other")`, and `LOCALE` for number/date formatting; static HTML holds Russian with English in `data-en`. Server messages use `tr(r, ru, en)`; `audio.UserError` carries both languages for upload validation errors.
- **Stats** (`store/stats.go`, `GET /api/admin/stats?days=&admins=0|1&tz=&difficulty=`) aggregate only finished attempts. `stats.js` draws hand-written SVG/HTML charts. The per-track "guessed" column on the admin Tracks tab (`ListTracks`) leaves out `WarmupDifficulty` attempts; the Statistics tab includes guests. Color convention: `--series` (blue) = actual results, `--chance` (orange) = what pure guessing (p = 1/4) would give.

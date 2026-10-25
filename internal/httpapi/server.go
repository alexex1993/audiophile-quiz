// Package httpapi wires the HTTP routes: Google auth, the quiz API, the admin API and the static UI.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/alexex/audiophile-quiz/internal/config"
	"github.com/alexex/audiophile-quiz/internal/store"
)

type Server struct {
	cfg    *config.Config
	store  *store.Store
	oauth  *oauth2.Config
	static fs.FS
}

func New(cfg *config.Config, st *store.Store, static fs.FS) *Server {
	return &Server{
		cfg:   cfg,
		store: st,
		oauth: &oauth2.Config{
			ClientID:     cfg.GoogleClientID,
			ClientSecret: cfg.GoogleClientSecret,
			RedirectURL:  cfg.RedirectURL(),
			Endpoint:     google.Endpoint,
			Scopes:       []string{"openid", "email", "profile"},
		},
		static: static,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /auth/google/login", s.handleLogin)
	mux.HandleFunc("GET /auth/google/callback", s.handleCallback)
	mux.HandleFunc("POST /auth/logout", s.handleLogout)

	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/me", s.requireUser(s.handleMe))
	mux.HandleFunc("POST /api/quiz/start", s.requireUser(s.handleStartQuiz))
	mux.HandleFunc("GET /api/quiz/history", s.requireUser(s.handleHistory))
	mux.HandleFunc("GET /api/quiz/{id}", s.requireUser(s.handleGetAttempt))
	mux.HandleFunc("POST /api/quiz/{id}/answer", s.requireUser(s.handleAnswer))
	mux.HandleFunc("POST /api/quiz/{id}/finish", s.requireUser(s.handleFinish))
	mux.HandleFunc("GET /api/audio/{token}", s.requireUser(s.handleQuizAudio))

	mux.HandleFunc("GET /api/admin/tracks", s.requireAdmin(s.handleListTracks))
	mux.HandleFunc("POST /api/admin/tracks", s.requireAdmin(s.handleUploadTrack))
	mux.HandleFunc("PATCH /api/admin/tracks/{id}", s.requireAdmin(s.handleUpdateTrack))
	mux.HandleFunc("DELETE /api/admin/tracks/{id}", s.requireAdmin(s.handleDeleteTrack))
	mux.HandleFunc("GET /api/admin/tracks/{id}/audio/{kind}", s.requireAdmin(s.handleAdminAudio))
	mux.HandleFunc("GET /api/admin/users", s.requireAdmin(s.handleUserStats))
	mux.HandleFunc("GET /api/admin/users/{id}/attempts", s.requireAdmin(s.handleUserAttempts))
	mux.HandleFunc("GET /api/admin/stats", s.requireAdmin(s.handleStats))

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	files := http.FileServerFS(s.static)
	mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, s.static, "admin.html")
	})
	mux.Handle("GET /", files)

	return s.securityHeaders(s.csrfGuard(mux))
}

// csrfGuard requires a custom header on state-changing API calls. Browsers
// never attach custom headers to cross-site form posts, and a cross-site
// fetch with one is blocked by CORS preflight.
func (s *Server) csrfGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Requested-With") != "fetch" {
			writeError(w, http.StatusForbidden, "missing X-Requested-With header")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// CleanupLoop periodically removes expired sessions.
func (s *Server) CleanupLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := s.store.DeleteExpiredSessions(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("cleanup sessions", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeStoreError maps store errors to HTTP responses.
func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, tr(r, "не найдено", "not found"))
	case errors.Is(err, store.ErrLimitReached):
		writeError(w, http.StatusTooManyRequests, tr(r, "на сегодня попытки закончились — приходите позже", "you're out of attempts for today — come back later"))
	case errors.Is(err, store.ErrNoTracks):
		writeError(w, http.StatusConflict, tr(r, "библиотека треков пока пуста", "the track library is empty"))
	case errors.Is(err, store.ErrAttemptClosed):
		writeError(w, http.StatusConflict, tr(r, "эта попытка уже завершена", "this attempt is already finished"))
	case errors.Is(err, store.ErrNotAllAnswers):
		writeError(w, http.StatusConflict, tr(r, "ответьте на все вопросы", "answer every question first"))
	default:
		slog.Error("request failed", "err", err)
		writeError(w, http.StatusInternalServerError, tr(r, "внутренняя ошибка сервера", "internal server error"))
	}
}

func pathID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id, err == nil && id > 0
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}

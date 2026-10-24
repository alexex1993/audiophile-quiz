package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/alexex/audiophile-quiz/internal/audio"
	"github.com/alexex/audiophile-quiz/internal/store"
)

// handleConfig exposes the public quiz rules for the landing page.
func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"clip_seconds": s.cfg.ClipSeconds,
		"difficulties": store.Difficulties,
	})
}

// attemptLimit is the daily attempt quota for the user; 0 means unlimited (admins).
func (s *Server) attemptLimit(user *store.User) int {
	if s.cfg.IsAdmin(user.Email) {
		return 0
	}
	return s.cfg.AttemptsPerDay
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	quota, err := s.store.Quota(r.Context(), user.ID, s.attemptLimit(user))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	tracks, err := s.store.CountActiveTracks(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	// Questions per level as an attempt would actually get them.
	levels := make([]store.Difficulty, len(store.Difficulties))
	for i, d := range store.Difficulties {
		d.Questions = min(d.Questions, tracks)
		levels[i] = d
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":             user,
		"is_admin":         s.cfg.IsAdmin(user.Email),
		"quota":            quota,
		"tracks_available": tracks,
		"difficulties":     levels,
	})
}

// handleStartQuiz resumes an unfinished attempt or starts a new one at the
// requested difficulty (JSON {"difficulty": "easy"|"medium"|"hard"}, medium by default).
func (s *Server) handleStartQuiz(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Difficulty string `json:"difficulty"`
	}
	if err := readJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, tr(r, "неверный запрос", "bad request"))
		return
	}
	if req.Difficulty == "" {
		req.Difficulty = store.DefaultDifficulty
	}
	if _, ok := store.DifficultyByName(req.Difficulty); !ok {
		writeError(w, http.StatusBadRequest, tr(r, "неизвестный уровень сложности", "unknown difficulty"))
		return
	}
	user := currentUser(r)
	id, err := s.store.StartAttempt(r.Context(), user.ID, s.attemptLimit(user), req.Difficulty)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.writeAttempt(w, r, id)
}

func (s *Server) handleGetAttempt(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, tr(r, "неверный id", "invalid id"))
		return
	}
	s.writeAttempt(w, r, id)
}

func (s *Server) writeAttempt(w http.ResponseWriter, r *http.Request, id int64) {
	a, err := s.store.GetAttempt(r.Context(), id, currentUser(r).ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) handleAnswer(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	var req struct {
		Position int `json:"position"`
		Answer   int `json:"answer"`
	}
	if !ok || readJSON(r, &req) != nil || req.Answer < 1 || req.Answer > 4 || req.Position < 1 {
		writeError(w, http.StatusBadRequest, tr(r, "неверный запрос", "bad request"))
		return
	}
	if err := s.store.AnswerQuestion(r.Context(), id, currentUser(r).ID, req.Position, req.Answer); err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleFinish(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, tr(r, "неверный id", "invalid id"))
		return
	}
	if err := s.store.FinishAttempt(r.Context(), id, currentUser(r).ID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.writeAttempt(w, r, id)
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListAttempts(r.Context(), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleQuizAudio streams one side of a question. The URL carries only an
// opaque token, and all FLACs of a track are padded to the same size and
// have identical headers, so nothing in the response reveals which version it is.
func (s *Server) handleQuizAudio(w http.ResponseWriter, r *http.Request) {
	ref, err := s.store.AudioByToken(r.Context(), r.PathValue("token"), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	name := audio.LosslessFile
	if ref.Kind == store.KindAAC {
		d, ok := store.DifficultyByName(ref.Difficulty)
		if !ok {
			writeStoreError(w, r, fmt.Errorf("attempt has unknown difficulty %q", ref.Difficulty))
			return
		}
		name = audio.EncodedFile(d.Bitrate())
	}
	s.serveClip(w, r, ref.StorageDir, name)
}

func (s *Server) serveClip(w http.ResponseWriter, r *http.Request, storageDir, name string) {
	f, err := os.Open(filepath.Join(s.cfg.DataDir, storageDir, name))
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, tr(r, "файл не найден", "file not found"))
		return
	} else if err != nil {
		writeStoreError(w, r, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "audio/flac")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// Zero modtime: no Last-Modified header, which could otherwise differ between the two files.
	http.ServeContent(w, r, "", time.Time{}, f)
}

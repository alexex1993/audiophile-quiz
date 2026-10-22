package httpapi

import (
	"errors"
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
		"attempts_per_week":  s.cfg.AttemptsPerWeek,
		"questions_per_quiz": s.cfg.QuestionsPerQuiz,
		"clip_seconds":       s.cfg.ClipSeconds,
		"aac_bitrate":        s.cfg.AACBitrate,
	})
}

// attemptLimit is the weekly attempt quota for the user; 0 means unlimited (admins).
func (s *Server) attemptLimit(user *store.User) int {
	if s.cfg.IsAdmin(user.Email) {
		return 0
	}
	return s.cfg.AttemptsPerWeek
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	quota, err := s.store.Quota(r.Context(), user.ID, s.attemptLimit(user))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	tracks, err := s.store.CountActiveTracks(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":               user,
		"is_admin":           s.cfg.IsAdmin(user.Email),
		"quota":              quota,
		"tracks_available":   tracks,
		"questions_per_quiz": min(tracks, s.cfg.QuestionsPerQuiz),
	})
}

// handleStartQuiz resumes an unfinished attempt or starts a new one.
func (s *Server) handleStartQuiz(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r)
	id, err := s.store.StartAttempt(r.Context(), user.ID, s.attemptLimit(user), s.cfg.QuestionsPerQuiz)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.writeAttempt(w, r, id)
}

func (s *Server) handleGetAttempt(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "неверный id")
		return
	}
	s.writeAttempt(w, r, id)
}

func (s *Server) writeAttempt(w http.ResponseWriter, r *http.Request, id int64) {
	a, err := s.store.GetAttempt(r.Context(), id, currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
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
		writeError(w, http.StatusBadRequest, "неверный запрос")
		return
	}
	if err := s.store.AnswerQuestion(r.Context(), id, currentUser(r).ID, req.Position, req.Answer); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleFinish(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "неверный id")
		return
	}
	if err := s.store.FinishAttempt(r.Context(), id, currentUser(r).ID); err != nil {
		writeStoreError(w, err)
		return
	}
	s.writeAttempt(w, r, id)
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListAttempts(r.Context(), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleQuizAudio streams one side of a question. The URL carries only an
// opaque token, and both WAVs of a track are the same size with identical
// headers, so nothing in the response reveals which version it is.
func (s *Server) handleQuizAudio(w http.ResponseWriter, r *http.Request) {
	ref, err := s.store.AudioByToken(r.Context(), r.PathValue("token"), currentUser(r).ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.serveClip(w, r, ref.StorageDir, ref.Kind)
}

func (s *Server) serveClip(w http.ResponseWriter, r *http.Request, storageDir, kind string) {
	name := audio.LosslessFile
	if kind == store.KindAAC {
		name = audio.EncodedFile
	}
	f, err := os.Open(filepath.Join(s.cfg.DataDir, storageDir, name))
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "файл не найден")
		return
	} else if err != nil {
		writeStoreError(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// Zero modtime: no Last-Modified header, which could otherwise differ between the two files.
	http.ServeContent(w, r, "", time.Time{}, f)
}

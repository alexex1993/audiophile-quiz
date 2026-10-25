package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/alexex/audiophile-quiz/internal/audio"
	"github.com/alexex/audiophile-quiz/internal/store"
)

func (s *Server) handleListTracks(w http.ResponseWriter, r *http.Request) {
	tracks, err := s.store.ListTracks(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if tracks == nil {
		tracks = []*store.Track{}
	}
	writeJSON(w, http.StatusOK, tracks)
}

// handleUploadTrack accepts a multipart form (file, artist, title, start),
// produces the lossless clip plus one AAC clip per difficulty and deletes the
// uploaded source.
func (s *Server) handleUploadTrack(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadMB<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, tr(r, "ожидается multipart/form-data", "multipart/form-data expected"))
		return
	}

	tmpDir := filepath.Join(s.cfg.DataDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		writeStoreError(w, r, err)
		return
	}
	fields := map[string]string{}
	var srcPath, srcName string
	// The source is only needed until the clips exist.
	defer func() {
		if srcPath != "" {
			os.Remove(srcPath)
		}
	}()

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, tr(r, "ошибка загрузки: ", "upload failed: ")+err.Error())
			return
		}
		if part.FileName() == "" {
			v, _ := io.ReadAll(io.LimitReader(part, 4096))
			fields[part.FormName()] = strings.TrimSpace(string(v))
			continue
		}
		if part.FormName() != "file" || srcPath != "" {
			continue
		}
		srcName = filepath.Base(part.FileName())
		f, err := os.CreateTemp(tmpDir, "upload-*"+strings.ToLower(filepath.Ext(srcName)))
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		srcPath = f.Name()
		_, err = io.Copy(f, part)
		f.Close()
		if err != nil {
			writeError(w, http.StatusBadRequest, tr(r, "ошибка загрузки файла: ", "file upload failed: ")+err.Error())
			return
		}
	}

	if srcPath == "" {
		writeError(w, http.StatusBadRequest, tr(r, "файл не передан", "no file uploaded"))
		return
	}
	title := fields["title"]
	if title == "" {
		title = strings.TrimSuffix(srcName, filepath.Ext(srcName))
	}
	start, err := parseTimestamp(fields["start"])
	if err != nil {
		writeError(w, http.StatusBadRequest, tr(r, "неверный формат начала отрывка: ", "invalid clip start: ")+strconv.Quote(fields["start"]))
		return
	}

	storageDir := filepath.Join("audio", randomHex())
	outDir := filepath.Join(s.cfg.DataDir, storageDir)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	res, err := audio.Process(ctx, srcPath, outDir, start, s.cfg.ClipSeconds, store.Bitrates())
	if err != nil {
		os.RemoveAll(outDir)
		slog.Warn("process upload", "file", srcName, "err", err)
		msg := tr(r, "ошибка обработки: ", "processing failed: ") + err.Error()
		var ue *audio.UserError
		if errors.As(err, &ue) {
			msg = tr(r, ue.RU, ue.EN)
		}
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}

	t := &store.Track{
		Artist:         fields["artist"],
		Title:          title,
		SourceFilename: srcName,
		SourceCodec:    res.Info.Codec,
		StartSeconds:   start,
		ClipSeconds:    s.cfg.ClipSeconds,
		SampleRate:     res.Info.SampleRate,
		Channels:       res.Info.Channels,
		BitDepth:       res.Info.BitDepth,
		PCMCodec:       "flac",
		AACBitrate:     clipBitrates(),
		StorageDir:     storageDir,
		FileSize:       res.FileSize,
	}
	if err := s.store.CreateTrack(r.Context(), t); err != nil {
		os.RemoveAll(outDir)
		writeStoreError(w, r, err)
		return
	}
	slog.Info("track added", "id", t.ID, "title", t.Title, "rate", t.SampleRate, "bits", t.BitDepth)
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleUpdateTrack(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	var req struct {
		Artist string `json:"artist"`
		Title  string `json:"title"`
		Active bool   `json:"active"`
	}
	if !ok || readJSON(r, &req) != nil || strings.TrimSpace(req.Title) == "" {
		writeError(w, http.StatusBadRequest, tr(r, "неверный запрос", "bad request"))
		return
	}
	if err := s.store.UpdateTrack(r.Context(), id, strings.TrimSpace(req.Artist), strings.TrimSpace(req.Title), req.Active); err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteTrack removes the track and its clips. Past results keep the
// track name; the questions just lose their audio.
func (s *Server) handleDeleteTrack(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, tr(r, "неверный id", "invalid id"))
		return
	}
	t, err := s.store.GetTrack(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if err := s.store.DeleteTrack(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	if err := os.RemoveAll(filepath.Join(s.cfg.DataDir, t.StorageDir)); err != nil {
		slog.Warn("remove track files", "id", id, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleAdminAudio serves a track's clip for preview; kind is "lossless" or a
// difficulty name for the AAC clip of that level.
func (s *Server) handleAdminAudio(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	kind := r.PathValue("kind")
	name := audio.LosslessFile
	if d, isLevel := store.DifficultyByName(kind); isLevel {
		name = audio.EncodedFile(d.Bitrate())
	} else if kind != store.KindLossless {
		ok = false
	}
	if !ok {
		writeError(w, http.StatusBadRequest, tr(r, "неверный запрос", "bad request"))
		return
	}
	t, err := s.store.GetTrack(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.serveClip(w, r, t.StorageDir, name)
}

func (s *Server) handleUserStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.UserStats(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if stats == nil {
		stats = []*store.UserStats{}
	}
	writeJSON(w, http.StatusOK, stats)
}

// handleUserAttempts lists a user's finished attempts with every answer.
func (s *Server) handleUserAttempts(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, tr(r, "неверный id", "invalid id"))
		return
	}
	attempts, err := s.store.UserAttempts(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if attempts == nil {
		attempts = []*store.Attempt{}
	}
	writeJSON(w, http.StatusOK, attempts)
}

// handleStats serves the statistics tab. Query: days (0 = all time),
// admins=0 to skip admins' attempts, tz (IANA name) for daily buckets,
// difficulty (a level name; empty = all levels).
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.StatsFilter{TimeZone: "UTC"}
	if d, err := strconv.Atoi(q.Get("days")); err == nil && d > 0 && d <= 3650 {
		f.Days = d
	}
	if _, ok := store.DifficultyByName(q.Get("difficulty")); ok {
		f.Difficulty = q.Get("difficulty")
	}
	if q.Get("admins") == "0" {
		for email := range s.cfg.AdminEmails {
			f.ExcludeEmails = append(f.ExcludeEmails, email)
		}
	}
	// Validated here so a bad name can't fail the query.
	if tz := q.Get("tz"); tz != "" && tz != "Local" {
		if _, err := time.LoadLocation(tz); err == nil {
			f.TimeZone = tz
		}
	}
	st, err := s.store.Stats(r.Context(), f)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// parseTimestamp accepts "75", "75.5", "1:15" or "1:15.5".
func parseTimestamp(v string) (float64, error) {
	v = strings.ReplaceAll(strings.TrimSpace(v), ",", ".")
	if v == "" {
		return 0, nil
	}
	var total float64
	parts := strings.Split(v, ":")
	if len(parts) > 3 {
		return 0, errors.New("too many colons")
	}
	for _, p := range parts {
		n, err := strconv.ParseFloat(p, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("bad number %q", p)
		}
		total = total*60 + n
	}
	return total, nil
}

func randomHex() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// clipBitrates is the aac_bitrate of a track whose clips match store.Difficulties.
func clipBitrates() string { return strings.Join(store.Bitrates(), "/") }

// SyncClips re-encodes the clips of every track made for other bitrates than
// store.Difficulties now has, from the track's own lossless clip. Called at
// startup, before anything is served. A track that fails is logged and left as is.
func (s *Server) SyncClips(ctx context.Context) error {
	tracks, err := s.store.ListTracks(ctx)
	if err != nil {
		return err
	}
	want := clipBitrates()
	for _, t := range tracks {
		if t.AACBitrate == want {
			continue
		}
		size, err := audio.Reencode(ctx, filepath.Join(s.cfg.DataDir, t.StorageDir), store.Bitrates())
		if err == nil {
			err = s.store.UpdateTrackClips(ctx, t.ID, want, size)
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Warn("re-encode track", "id", t.ID, "title", t.Title, "from", t.AACBitrate, "err", err)
			continue
		}
		slog.Info("track re-encoded", "id", t.ID, "title", t.Title, "from", t.AACBitrate, "to", want)
	}
	return nil
}

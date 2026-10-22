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
		writeStoreError(w, err)
		return
	}
	if tracks == nil {
		tracks = []*store.Track{}
	}
	writeJSON(w, http.StatusOK, tracks)
}

// handleUploadTrack accepts a multipart form (file, artist, title, start),
// produces both clips and deletes the uploaded source.
func (s *Server) handleUploadTrack(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadMB<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "ожидается multipart/form-data")
		return
	}

	tmpDir := filepath.Join(s.cfg.DataDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		writeStoreError(w, err)
		return
	}
	fields := map[string]string{}
	var srcPath, srcName string
	// The source is only needed until both clips exist.
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
			writeError(w, http.StatusBadRequest, "ошибка загрузки: "+err.Error())
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
			writeStoreError(w, err)
			return
		}
		srcPath = f.Name()
		_, err = io.Copy(f, part)
		f.Close()
		if err != nil {
			writeError(w, http.StatusBadRequest, "ошибка загрузки файла: "+err.Error())
			return
		}
	}

	if srcPath == "" {
		writeError(w, http.StatusBadRequest, "файл не передан")
		return
	}
	title := fields["title"]
	if title == "" {
		title = strings.TrimSuffix(srcName, filepath.Ext(srcName))
	}
	start, err := parseTimestamp(fields["start"])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	storageDir := filepath.Join("audio", randomHex())
	outDir := filepath.Join(s.cfg.DataDir, storageDir)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	res, err := audio.Process(ctx, srcPath, outDir, start, s.cfg.ClipSeconds, s.cfg.AACBitrate)
	if err != nil {
		os.RemoveAll(outDir)
		slog.Warn("process upload", "file", srcName, "err", err)
		writeError(w, http.StatusUnprocessableEntity, err.Error())
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
		PCMCodec:       res.PCMCodec,
		AACBitrate:     s.cfg.AACBitrate,
		StorageDir:     storageDir,
		FileSize:       res.FileSize,
	}
	if err := s.store.CreateTrack(r.Context(), t); err != nil {
		os.RemoveAll(outDir)
		writeStoreError(w, err)
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
		writeError(w, http.StatusBadRequest, "неверный запрос")
		return
	}
	if err := s.store.UpdateTrack(r.Context(), id, strings.TrimSpace(req.Artist), strings.TrimSpace(req.Title), req.Active); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteTrack removes the track and its clips. Past results keep the
// track name; the questions just lose their audio.
func (s *Server) handleDeleteTrack(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "неверный id")
		return
	}
	t, err := s.store.GetTrack(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := s.store.DeleteTrack(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	if err := os.RemoveAll(filepath.Join(s.cfg.DataDir, t.StorageDir)); err != nil {
		slog.Warn("remove track files", "id", id, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminAudio(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r)
	kind := r.PathValue("kind")
	if !ok || (kind != store.KindLossless && kind != store.KindAAC) {
		writeError(w, http.StatusBadRequest, "неверный запрос")
		return
	}
	t, err := s.store.GetTrack(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.serveClip(w, r, t.StorageDir, kind)
}

func (s *Server) handleUserStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.UserStats(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if stats == nil {
		stats = []*store.UserStats{}
	}
	writeJSON(w, http.StatusOK, stats)
}

// handleStats serves the statistics tab. Query: days (0 = all time),
// admins=0 to skip admins' attempts, tz (IANA name) for daily buckets.
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.StatsFilter{TimeZone: "UTC"}
	if d, err := strconv.Atoi(q.Get("days")); err == nil && d > 0 && d <= 3650 {
		f.Days = d
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
		writeStoreError(w, err)
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
		return 0, errors.New("неверный формат начала отрывка")
	}
	for _, p := range parts {
		n, err := strconv.ParseFloat(p, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("неверный формат начала отрывка: %q", v)
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

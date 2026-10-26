package store

import (
	"context"
	"time"
)

type Track struct {
	ID             int64     `json:"id"`
	Artist         string    `json:"artist"`
	Title          string    `json:"title"`
	SourceFilename string    `json:"source_filename"`
	SourceCodec    string    `json:"source_codec"`
	StartSeconds   float64   `json:"start_seconds"`
	ClipSeconds    int       `json:"clip_seconds"`
	SampleRate     int       `json:"sample_rate"`
	Channels       int       `json:"channels"`
	BitDepth       int       `json:"bit_depth"`
	PCMCodec       string    `json:"pcm_codec"`
	AACBitrate     string    `json:"aac_bitrate"`
	StorageDir     string    `json:"-"`
	FileSize       int64     `json:"file_size"`
	Active         bool      `json:"active"`
	CreatedAt      time.Time `json:"created_at"`
	TimesPlayed    int       `json:"times_played"`
	TimesCorrect   int       `json:"times_correct"`
}

const trackCols = `t.id, t.artist, t.title, t.source_filename, t.source_codec, t.start_seconds, t.clip_seconds,
	t.sample_rate, t.channels, t.bit_depth, t.pcm_codec, t.aac_bitrate, t.storage_dir, t.file_size, t.active, t.created_at`

func scanTrack(row interface{ Scan(...any) error }, extra ...any) (*Track, error) {
	t := &Track{}
	dest := []any{&t.ID, &t.Artist, &t.Title, &t.SourceFilename, &t.SourceCodec, &t.StartSeconds, &t.ClipSeconds,
		&t.SampleRate, &t.Channels, &t.BitDepth, &t.PCMCodec, &t.AACBitrate, &t.StorageDir, &t.FileSize, &t.Active, &t.CreatedAt}
	err := row.Scan(append(dest, extra...)...)
	return t, notFound(err)
}

func (s *Store) CreateTrack(ctx context.Context, t *Track) error {
	return s.db.QueryRow(ctx, `
		INSERT INTO tracks (artist, title, source_filename, source_codec, start_seconds, clip_seconds,
			sample_rate, channels, bit_depth, pcm_codec, aac_bitrate, storage_dir, file_size)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id, active, created_at`,
		t.Artist, t.Title, t.SourceFilename, t.SourceCodec, t.StartSeconds, t.ClipSeconds,
		t.SampleRate, t.Channels, t.BitDepth, t.PCMCodec, t.AACBitrate, t.StorageDir, t.FileSize,
	).Scan(&t.ID, &t.Active, &t.CreatedAt)
}

// ListTracks returns all tracks with answer statistics from answered
// questions; warm-up attempts are left out, their artefacts are too obvious to tell anything.
func (s *Store) ListTracks(ctx context.Context) ([]*Track, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+trackCols+`,
			count(q.user_answer)::int,
			count(*) FILTER (WHERE q.user_answer = q.correct_answer)::int
		FROM tracks t LEFT JOIN (attempt_questions q JOIN attempts a ON a.id = q.attempt_id AND a.difficulty <> $1)
			ON q.track_id = t.id
		GROUP BY t.id ORDER BY t.id DESC`, WarmupDifficulty)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Track
	for rows.Next() {
		var played, correct int
		t, err := scanTrack(rows, &played, &correct)
		if err != nil {
			return nil, err
		}
		t.TimesPlayed, t.TimesCorrect = played, correct
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) GetTrack(ctx context.Context, id int64) (*Track, error) {
	return scanTrack(s.db.QueryRow(ctx, `SELECT `+trackCols+` FROM tracks t WHERE t.id = $1`, id))
}

func (s *Store) UpdateTrack(ctx context.Context, id int64, artist, title string, active bool) error {
	tag, err := s.db.Exec(ctx, `UPDATE tracks SET artist = $2, title = $3, active = $4 WHERE id = $1`,
		id, artist, title, active)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// UpdateTrackClips records that a track's clips were re-encoded for other bitrates.
func (s *Store) UpdateTrackClips(ctx context.Context, id int64, aacBitrate string, fileSize int64) error {
	_, err := s.db.Exec(ctx, `UPDATE tracks SET aac_bitrate = $2, file_size = $3 WHERE id = $1`, id, aacBitrate, fileSize)
	return err
}

func (s *Store) DeleteTrack(ctx context.Context, id int64) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM tracks WHERE id = $1`, id)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) CountActiveTracks(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM tracks WHERE active`).Scan(&n)
	return n, err
}

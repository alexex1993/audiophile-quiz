package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	KindLossless = "lossless"
	KindAAC      = "aac"

	// The four answer options, in the order they are shown to the user.
	AnswerFirstLossless  = 1
	AnswerSecondLossless = 2
	AnswerBothLossless   = 3
	AnswerBothCompressed = 4

	quotaWindow = 24 * time.Hour
)

var (
	ErrLimitReached  = errors.New("daily attempt limit reached")
	ErrNoTracks      = errors.New("track library is empty")
	ErrAttemptClosed = errors.New("attempt is already finished")
	ErrNotAllAnswers = errors.New("not every question is answered")
)

// Difficulty is a quiz level: the AAC bitrate the compressed clips went
// through (the lower it is, the easier the artefacts are to hear) and how
// many tracks an attempt has; fewer if the library is smaller.
type Difficulty struct {
	Name      string `json:"name"`
	Kbps      int    `json:"kbps"`
	Questions int    `json:"questions"`
}

// Bitrate is the ffmpeg -b:a value, e.g. "128k"; also part of the clip file name.
func (d Difficulty) Bitrate() string { return strconv.Itoa(d.Kbps) + "k" }

// Difficulties, easiest first. Names must match the CHECK on attempts.difficulty.
var Difficulties = []Difficulty{{"easy", 32, 5}, {"medium", 128, 12}, {"hard", 320, 12}}

const DefaultDifficulty = "medium"

func DifficultyByName(name string) (Difficulty, bool) {
	for _, d := range Difficulties {
		if d.Name == name {
			return d, true
		}
	}
	return Difficulty{}, false
}

// Bitrates lists the bitrate of every difficulty, the clips each track needs.
func Bitrates() []string {
	out := make([]string, len(Difficulties))
	for i, d := range Difficulties {
		out[i] = d.Bitrate()
	}
	return out
}

// answerKinds maps each answer option to the pair of files it describes.
var answerKinds = map[int][2]string{
	AnswerFirstLossless:  {KindLossless, KindAAC},
	AnswerSecondLossless: {KindAAC, KindLossless},
	AnswerBothLossless:   {KindLossless, KindLossless},
	AnswerBothCompressed: {KindAAC, KindAAC},
}

type Attempt struct {
	ID         int64       `json:"id"`
	UserID     int64       `json:"-"`
	StartedAt  time.Time   `json:"started_at"`
	FinishedAt *time.Time  `json:"finished_at"`
	Score      *int        `json:"score"`
	Total      int         `json:"total"`
	Difficulty string      `json:"difficulty"`
	Questions  []*Question `json:"questions,omitempty"`
}

type Question struct {
	Position      int        `json:"position"`
	TrackArtist   string     `json:"artist"`
	TrackTitle    string     `json:"title"`
	TokenA        string     `json:"token_a,omitempty"`
	TokenB        string     `json:"token_b,omitempty"`
	UserAnswer    *int       `json:"user_answer"`
	AnsweredAt    *time.Time `json:"-"`
	CorrectAnswer int        `json:"correct_answer,omitempty"` // only exposed once the attempt is finished
	KindA         string     `json:"kind_a,omitempty"`
	KindB         string     `json:"kind_b,omitempty"`
}

// Quota is what the user may know about their attempt limit. The limit
// itself is hidden from players: they only learn that it is exhausted.
type Quota struct {
	Unlimited  bool       `json:"unlimited"`           // limit <= 0, e.g. for admins
	Used       *int       `json:"used,omitempty"`      // attempts in the window; unlimited users only
	Exhausted  bool       `json:"exhausted"`           // no new attempt can be started now
	NextSlot   *time.Time `json:"next_slot,omitempty"` // when exhausted: when the next attempt frees up
	Unfinished *int64     `json:"unfinished_attempt_id"`
	// UnfinishedDifficulty is the level of the unfinished attempt, if any.
	UnfinishedDifficulty *string `json:"unfinished_difficulty"`
}

func (s *Store) Quota(ctx context.Context, userID int64, limit int) (*Quota, error) {
	q := &Quota{Unlimited: limit <= 0}
	rows, err := s.db.Query(ctx, `
		SELECT started_at FROM attempts WHERE user_id = $1 AND started_at > now() - $2::interval
		ORDER BY started_at`, userID, quotaWindow)
	if err != nil {
		return nil, err
	}
	started, err := pgx.CollectRows(rows, pgx.RowTo[time.Time])
	if err != nil {
		return nil, err
	}
	if q.Unlimited {
		q.Used = new(int)
		*q.Used = len(started)
	} else if used := len(started); used >= limit {
		// A slot frees up once enough of the oldest attempts leave the window.
		t := started[used-limit].Add(quotaWindow)
		q.Exhausted, q.NextSlot = true, &t
	}
	var id int64
	var difficulty string
	err = s.db.QueryRow(ctx, `SELECT id, difficulty FROM attempts WHERE user_id = $1 AND finished_at IS NULL ORDER BY id DESC LIMIT 1`,
		userID).Scan(&id, &difficulty)
	if err == nil {
		q.Unfinished, q.UnfinishedDifficulty = &id, &difficulty
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return q, nil
}

// StartAttempt resumes the user's unfinished attempt (whatever its difficulty)
// or, if the daily quota allows, creates a new one at difficulty with up to n
// random active tracks. limit <= 0 means unlimited. The quota is shared by all levels.
func (s *Store) StartAttempt(ctx context.Context, userID int64, limit int, difficulty string) (int64, error) {
	level, ok := DifficultyByName(difficulty)
	if !ok {
		return 0, fmt.Errorf("unknown difficulty %q", difficulty)
	}
	var attemptID int64
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		// Serialises concurrent starts by the same user so the quota can't be exceeded.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, userID); err != nil {
			return err
		}
		err := tx.QueryRow(ctx, `SELECT id FROM attempts WHERE user_id = $1 AND finished_at IS NULL ORDER BY id DESC LIMIT 1`,
			userID).Scan(&attemptID)
		if err == nil {
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		var used int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE user_id = $1 AND started_at > now() - $2::interval`,
			userID, quotaWindow).Scan(&used); err != nil {
			return err
		}
		if limit > 0 && used >= limit {
			return ErrLimitReached
		}

		rows, err := tx.Query(ctx, `SELECT id, artist, title FROM tracks WHERE active ORDER BY random() LIMIT $1`, level.Questions)
		if err != nil {
			return err
		}
		type pick struct {
			id            int64
			artist, title string
		}
		picks, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (pick, error) {
			var p pick
			return p, r.Scan(&p.id, &p.artist, &p.title)
		})
		if err != nil {
			return err
		}
		if len(picks) == 0 {
			return ErrNoTracks
		}

		if err := tx.QueryRow(ctx, `INSERT INTO attempts (user_id, total, difficulty) VALUES ($1, $2, $3) RETURNING id`,
			userID, len(picks), difficulty).Scan(&attemptID); err != nil {
			return err
		}
		for i, p := range picks {
			answer := randomAnswer()
			kinds := answerKinds[answer]
			if _, err := tx.Exec(ctx, `
				INSERT INTO attempt_questions (attempt_id, position, track_id, track_artist, track_title,
					kind_a, kind_b, correct_answer, token_a, token_b)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				attemptID, i+1, p.id, p.artist, p.title, kinds[0], kinds[1], answer, randomToken(), randomToken(),
			); err != nil {
				return err
			}
		}
		return nil
	})
	return attemptID, err
}

// GetAttempt loads an attempt owned by userID. Correct answers are filled in
// only when the attempt is finished.
func (s *Store) GetAttempt(ctx context.Context, attemptID, userID int64) (*Attempt, error) {
	a := &Attempt{}
	err := s.db.QueryRow(ctx, `SELECT id, user_id, started_at, finished_at, score, total, difficulty FROM attempts WHERE id = $1 AND user_id = $2`,
		attemptID, userID).Scan(&a.ID, &a.UserID, &a.StartedAt, &a.FinishedAt, &a.Score, &a.Total, &a.Difficulty)
	if err != nil {
		return nil, notFound(err)
	}
	rows, err := s.db.Query(ctx, `
		SELECT position, track_artist, track_title, token_a, token_b, user_answer, answered_at, correct_answer, kind_a, kind_b
		FROM attempt_questions WHERE attempt_id = $1 ORDER BY position`, attemptID)
	if err != nil {
		return nil, err
	}
	a.Questions, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Question, error) {
		q := &Question{}
		err := r.Scan(&q.Position, &q.TrackArtist, &q.TrackTitle, &q.TokenA, &q.TokenB, &q.UserAnswer, &q.AnsweredAt,
			&q.CorrectAnswer, &q.KindA, &q.KindB)
		if a.FinishedAt == nil {
			q.CorrectAnswer, q.KindA, q.KindB = 0, "", ""
		}
		return q, err
	})
	return a, err
}

func (s *Store) AnswerQuestion(ctx context.Context, attemptID, userID int64, position, answer int) error {
	tag, err := s.db.Exec(ctx, `
		UPDATE attempt_questions q SET user_answer = $4, answered_at = now()
		FROM attempts a
		WHERE q.attempt_id = a.id AND a.id = $1 AND a.user_id = $2 AND q.position = $3 AND a.finished_at IS NULL`,
		attemptID, userID, position, answer)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		a, err := s.GetAttempt(ctx, attemptID, userID)
		if err != nil {
			return err
		}
		if a.FinishedAt != nil {
			return ErrAttemptClosed
		}
		return ErrNotFound
	}
	return nil
}

func (s *Store) FinishAttempt(ctx context.Context, attemptID, userID int64) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var finished *time.Time
		err := tx.QueryRow(ctx, `SELECT finished_at FROM attempts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
			attemptID, userID).Scan(&finished)
		if err != nil {
			return notFound(err)
		}
		if finished != nil {
			return ErrAttemptClosed
		}
		var unanswered int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM attempt_questions WHERE attempt_id = $1 AND user_answer IS NULL`,
			attemptID).Scan(&unanswered); err != nil {
			return err
		}
		if unanswered > 0 {
			return ErrNotAllAnswers
		}
		_, err = tx.Exec(ctx, `
			UPDATE attempts SET finished_at = now(),
				score = (SELECT count(*) FROM attempt_questions WHERE attempt_id = $1 AND user_answer = correct_answer)
			WHERE id = $1`, attemptID)
		return err
	})
}

func (s *Store) ListAttempts(ctx context.Context, userID int64) ([]*Attempt, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, user_id, started_at, finished_at, score, total, difficulty FROM attempts
		WHERE user_id = $1 AND finished_at IS NOT NULL ORDER BY started_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Attempt, error) {
		a := &Attempt{}
		return a, r.Scan(&a.ID, &a.UserID, &a.StartedAt, &a.FinishedAt, &a.Score, &a.Total, &a.Difficulty)
	})
}

// UserAttempts lists a user's finished attempts, newest first, each with its
// questions and correct answers, for the admin panel. Audio tokens are left
// out: they only play for the attempt's owner.
func (s *Store) UserAttempts(ctx context.Context, userID int64) ([]*Attempt, error) {
	attempts, err := s.ListAttempts(ctx, userID)
	if err != nil || len(attempts) == 0 {
		return attempts, err
	}
	byID := make(map[int64]*Attempt, len(attempts))
	for _, a := range attempts {
		byID[a.ID] = a
	}
	rows, err := s.db.Query(ctx, `
		SELECT q.attempt_id, q.position, q.track_artist, q.track_title, q.user_answer, q.answered_at, q.correct_answer, q.kind_a, q.kind_b
		FROM attempt_questions q JOIN attempts a ON a.id = q.attempt_id
		WHERE a.user_id = $1 AND a.finished_at IS NOT NULL ORDER BY q.attempt_id, q.position`, userID)
	if err != nil {
		return nil, err
	}
	var attemptID int64
	q := &Question{}
	_, err = pgx.ForEachRow(rows, []any{&attemptID, &q.Position, &q.TrackArtist, &q.TrackTitle, &q.UserAnswer, &q.AnsweredAt,
		&q.CorrectAnswer, &q.KindA, &q.KindB}, func() error {
		if a := byID[attemptID]; a != nil {
			c := *q
			a.Questions = append(a.Questions, &c)
		}
		return nil
	})
	return attempts, err
}

type AudioRef struct {
	StorageDir string
	Kind       string
	Difficulty string
	FileSize   int64
}

// AudioByToken resolves an opaque per-question audio token for its owner.
func (s *Store) AudioByToken(ctx context.Context, token string, userID int64) (*AudioRef, error) {
	ref := &AudioRef{}
	err := s.db.QueryRow(ctx, `
		SELECT t.storage_dir, CASE WHEN q.token_a = $1 THEN q.kind_a ELSE q.kind_b END, a.difficulty, t.file_size
		FROM attempt_questions q
		JOIN attempts a ON a.id = q.attempt_id
		JOIN tracks t ON t.id = q.track_id
		WHERE (q.token_a = $1 OR q.token_b = $1) AND a.user_id = $2`, token, userID,
	).Scan(&ref.StorageDir, &ref.Kind, &ref.Difficulty, &ref.FileSize)
	return ref, notFound(err)
}

type UserStats struct {
	User
	Attempts   int        `json:"attempts"`
	BestScore  *int       `json:"best_score"`
	AvgPercent *float64   `json:"avg_percent"`
	LastPlayed *time.Time `json:"last_played"`
}

// UserStats summarises finished attempts per user, for the admin panel.
func (s *Store) UserStats(ctx context.Context) ([]*UserStats, error) {
	rows, err := s.db.Query(ctx, `
		SELECT u.id, u.google_sub, u.email, u.name, u.picture, u.created_at, u.last_login_at,
			count(a.id)::int, max(a.score),
			avg(a.score::float8 * 100 / NULLIF(a.total, 0)),
			max(a.finished_at)
		FROM users u LEFT JOIN attempts a ON a.user_id = u.id AND a.finished_at IS NOT NULL
		GROUP BY u.id ORDER BY max(a.finished_at) DESC NULLS LAST, u.id DESC`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (*UserStats, error) {
		st := &UserStats{}
		return st, r.Scan(&st.ID, &st.GoogleSub, &st.Email, &st.Name, &st.Picture, &st.CreatedAt, &st.LastLoginAt,
			&st.Attempts, &st.BestScore, &st.AvgPercent, &st.LastPlayed)
	})
}

func randomAnswer() int {
	n, err := rand.Int(rand.Reader, big.NewInt(4))
	if err != nil {
		panic(err)
	}
	return int(n.Int64()) + 1
}

func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

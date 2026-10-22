package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math/big"
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

	quotaWindow = 7 * 24 * time.Hour // keep in sync with "interval '7 days'" in the queries
)

var (
	ErrLimitReached  = errors.New("weekly attempt limit reached")
	ErrNoTracks      = errors.New("track library is empty")
	ErrAttemptClosed = errors.New("attempt is already finished")
	ErrNotAllAnswers = errors.New("not every question is answered")
)

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
	Questions  []*Question `json:"questions,omitempty"`
}

type Question struct {
	Position      int        `json:"position"`
	TrackArtist   string     `json:"artist"`
	TrackTitle    string     `json:"title"`
	TokenA        string     `json:"token_a"`
	TokenB        string     `json:"token_b"`
	UserAnswer    *int       `json:"user_answer"`
	AnsweredAt    *time.Time `json:"-"`
	CorrectAnswer int        `json:"correct_answer,omitempty"` // only exposed once the attempt is finished
	KindA         string     `json:"kind_a,omitempty"`
	KindB         string     `json:"kind_b,omitempty"`
}

type Quota struct {
	Limit      int        `json:"limit"`
	Unlimited  bool       `json:"unlimited"` // limit <= 0, e.g. for admins
	Used       int        `json:"used"`
	Left       int        `json:"left"`
	NextSlot   *time.Time `json:"next_slot"` // when the oldest attempt in the window stops counting
	Unfinished *int64     `json:"unfinished_attempt_id"`
}

func (s *Store) Quota(ctx context.Context, userID int64, limit int) (*Quota, error) {
	q := &Quota{Limit: limit, Unlimited: limit <= 0}
	var oldest *time.Time
	err := s.db.QueryRow(ctx, `
		SELECT count(*)::int, min(started_at) FROM attempts
		WHERE user_id = $1 AND started_at > now() - interval '7 days'`,
		userID).Scan(&q.Used, &oldest)
	if err != nil {
		return nil, err
	}
	q.Left = max(limit-q.Used, 0)
	if oldest != nil {
		t := oldest.Add(quotaWindow)
		q.NextSlot = &t
	}
	var id int64
	err = s.db.QueryRow(ctx, `SELECT id FROM attempts WHERE user_id = $1 AND finished_at IS NULL ORDER BY id DESC LIMIT 1`,
		userID).Scan(&id)
	if err == nil {
		q.Unfinished = &id
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return q, nil
}

// StartAttempt resumes the user's unfinished attempt or, if the weekly quota
// allows, creates a new one with up to n random active tracks. limit <= 0 means unlimited.
func (s *Store) StartAttempt(ctx context.Context, userID int64, limit, n int) (int64, error) {
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
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE user_id = $1 AND started_at > now() - interval '7 days'`,
			userID).Scan(&used); err != nil {
			return err
		}
		if limit > 0 && used >= limit {
			return ErrLimitReached
		}

		rows, err := tx.Query(ctx, `SELECT id, artist, title FROM tracks WHERE active ORDER BY random() LIMIT $1`, n)
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

		if err := tx.QueryRow(ctx, `INSERT INTO attempts (user_id, total) VALUES ($1, $2) RETURNING id`,
			userID, len(picks)).Scan(&attemptID); err != nil {
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
	err := s.db.QueryRow(ctx, `SELECT id, user_id, started_at, finished_at, score, total FROM attempts WHERE id = $1 AND user_id = $2`,
		attemptID, userID).Scan(&a.ID, &a.UserID, &a.StartedAt, &a.FinishedAt, &a.Score, &a.Total)
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
		SELECT id, user_id, started_at, finished_at, score, total FROM attempts
		WHERE user_id = $1 AND finished_at IS NOT NULL ORDER BY started_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Attempt, error) {
		a := &Attempt{}
		return a, r.Scan(&a.ID, &a.UserID, &a.StartedAt, &a.FinishedAt, &a.Score, &a.Total)
	})
}

type AudioRef struct {
	StorageDir string
	Kind       string
	FileSize   int64
}

// AudioByToken resolves an opaque per-question audio token for its owner.
func (s *Store) AudioByToken(ctx context.Context, token string, userID int64) (*AudioRef, error) {
	ref := &AudioRef{}
	err := s.db.QueryRow(ctx, `
		SELECT t.storage_dir, CASE WHEN q.token_a = $1 THEN q.kind_a ELSE q.kind_b END, t.file_size
		FROM attempt_questions q
		JOIN attempts a ON a.id = q.attempt_id
		JOIN tracks t ON t.id = q.track_id
		WHERE (q.token_a = $1 OR q.token_b = $1) AND a.user_id = $2`, token, userID,
	).Scan(&ref.StorageDir, &ref.Kind, &ref.FileSize)
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

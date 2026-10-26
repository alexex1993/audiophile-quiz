package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type User struct {
	ID          int64     `json:"id"`
	Guest       bool      `json:"guest"` // no Google account: google_sub is NULL, email is ''
	Email       string    `json:"email"`
	Name        string    `json:"name"`
	Picture     string    `json:"picture"`
	CreatedAt   time.Time `json:"created_at"`
	LastLoginAt time.Time `json:"last_login_at"`
}

const userCols = `id, google_sub IS NULL, email, name, picture, created_at, last_login_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Guest, &u.Email, &u.Name, &u.Picture, &u.CreatedAt, &u.LastLoginAt)
	return u, notFound(err)
}

// UpsertGoogleUser creates the user on first login and refreshes the profile afterwards.
func (s *Store) UpsertGoogleUser(ctx context.Context, sub, email, name, picture string) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `
		INSERT INTO users (google_sub, email, name, picture) VALUES ($1, $2, $3, $4)
		ON CONFLICT (google_sub) DO UPDATE
		SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, last_login_at = now()
		RETURNING `+userCols, sub, email, name, picture))
}

// CreateGuest creates an anonymous user; the caller gives it a session.
func (s *Store) CreateGuest(ctx context.Context) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `INSERT INTO users (email) VALUES ('') RETURNING `+userCols))
}

// MergeGuest hands a guest's finished attempts over to userID (they then count
// towards that user's quota) and deletes the guest with everything else it had.
func (s *Store) MergeGuest(ctx context.Context, guestID, userID int64) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE attempts SET user_id = $2
			WHERE user_id = $1 AND finished_at IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id = $1 AND google_sub IS NULL)`,
			guestID, userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1 AND google_sub IS NULL`, guestID)
		return err
	})
}

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, userID int64, expires time.Time) error {
	_, err := s.db.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		tokenHash, userID, expires)
	return err
}

func (s *Store) SessionUser(ctx context.Context, tokenHash []byte) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `
		SELECT `+userCols+` FROM users
		WHERE id = (SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now())`, tokenHash))
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// DeleteExpiredSessions also removes guests left without a session and
// without a finished attempt: nobody can come back to them.
func (s *Store) DeleteExpiredSessions(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()`); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `
		DELETE FROM users u WHERE u.google_sub IS NULL
			AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
			AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.user_id = u.id AND a.finished_at IS NOT NULL)`)
	return err
}

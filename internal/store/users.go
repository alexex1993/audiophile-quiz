package store

import (
	"context"
	"time"
)

type User struct {
	ID          int64     `json:"id"`
	GoogleSub   string    `json:"-"`
	Email       string    `json:"email"`
	Name        string    `json:"name"`
	Picture     string    `json:"picture"`
	CreatedAt   time.Time `json:"created_at"`
	LastLoginAt time.Time `json:"last_login_at"`
}

const userCols = `id, google_sub, email, name, picture, created_at, last_login_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.GoogleSub, &u.Email, &u.Name, &u.Picture, &u.CreatedAt, &u.LastLoginAt)
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

func (s *Store) DeleteExpiredSessions(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()`)
	return err
}

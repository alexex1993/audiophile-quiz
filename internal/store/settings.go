package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

const maintenanceKey = "maintenance"

// Maintenance reports whether the site is closed for maintenance.
func (s *Store) Maintenance(ctx context.Context) (bool, error) {
	var v string
	err := s.db.QueryRow(ctx, `SELECT value FROM settings WHERE key = $1`, maintenanceKey).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return v == "on", err
}

func (s *Store) SetMaintenance(ctx context.Context, on bool) error {
	v := "off"
	if on {
		v = "on"
	}
	_, err := s.db.Exec(ctx, `INSERT INTO settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, maintenanceKey, v)
	return err
}

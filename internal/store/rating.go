package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ratingRetryPenalty discounts the rating for every rated attempt after the
// first: best / (1 + penalty·(n−1)), so fishing for one lucky run doesn't pay.
const ratingRetryPenalty = 0.1

// Rank is all a player learns about the rating: their own place (ties share
// it) among all rated players. Points and other players never leave the store.
type Rank struct {
	Place int `json:"place"`
	Total int `json:"total"`
}

// UserRank places the user among Google users with a finished attempt at a
// level with a RankWeight. An attempt is worth weight × how far its score is
// above guessing (0 at p = 1/4 or below, 1 at a perfect score); a player's
// rating is their best attempt, discounted by ratingRetryPenalty. Players
// with excluded emails (admins) are left out, unless userID is one of them.
// Returns nil if the user has no rated attempt.
func (s *Store) UserRank(ctx context.Context, userID int64, excludeEmails []string) (*Rank, error) {
	names, weights := []string{}, []float64{}
	for _, d := range Difficulties {
		if d.RankWeight > 0 {
			names, weights = append(names, d.Name), append(weights, d.RankWeight)
		}
	}
	if excludeEmails == nil {
		excludeEmails = []string{} // NULL would make "<> ALL" exclude everyone
	}
	r := &Rank{}
	err := s.db.QueryRow(ctx, `
		WITH rated AS (
			SELECT a.user_id,
				max(w.weight * greatest(a.score::float8 / a.total - 0.25, 0) / 0.75) AS best,
				count(*) AS n
			FROM attempts a
			JOIN unnest($2::text[], $3::float8[]) AS w(name, weight) ON w.name = a.difficulty
			JOIN users u ON u.id = a.user_id
			WHERE a.finished_at IS NOT NULL AND u.google_sub IS NOT NULL
				AND (u.id = $1 OR lower(u.email) <> ALL($4::text[]))
			GROUP BY a.user_id
		), rating AS (
			-- Rounded so that equal results tie despite float noise.
			SELECT user_id, round((best / (1 + $5::float8 * (n - 1)))::numeric, 9) AS r FROM rated
		)
		SELECT 1 + (SELECT count(*) FROM rating o WHERE o.r > me.r), (SELECT count(*) FROM rating)
		FROM rating me WHERE me.user_id = $1`,
		userID, names, weights, excludeEmails, ratingRetryPenalty).Scan(&r.Place, &r.Total)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// StatsFilter scopes the admin statistics. Only finished attempts are counted.
type StatsFilter struct {
	Days          int      // 0 = all time
	ExcludeEmails []string // lower-cased emails whose attempts are skipped (admins)
	TimeZone      string   // IANA name used to bucket attempts by day
}

type Stats struct {
	Summary     StatsSummary    `json:"summary"`
	Scores      []ScoreBucket   `json:"scores"`
	Confusion   []ConfusionCell `json:"confusion"`
	ByPosition  []AccuracyRow   `json:"by_position"`
	ByAttemptNo []AccuracyRow   `json:"by_attempt_no"`
	ByTrack     []TrackAccuracy `json:"by_track"`
	Daily       []DailyRow      `json:"daily"`
}

type StatsSummary struct {
	Attempts   int `json:"attempts"`
	Players    int `json:"players"`
	Questions  int `json:"questions"`
	Correct    int `json:"correct"`
	Unfinished int `json:"unfinished"`
}

type ScoreBucket struct {
	Score int `json:"score"`
	Total int `json:"total"`
	Count int `json:"count"`
}

type ConfusionCell struct {
	Correct int `json:"correct"`
	Answer  int `json:"answer"`
	Count   int `json:"count"`
}

// AccuracyRow is answered/correct questions for one value of a dimension
// (question position, or the player's n-th attempt).
type AccuracyRow struct {
	Key      int `json:"key"`
	Answered int `json:"answered"`
	Correct  int `json:"correct"`
}

type TrackAccuracy struct {
	TrackID    *int64 `json:"track_id"` // nil when the track was deleted
	Artist     string `json:"artist"`
	Title      string `json:"title"`
	SampleRate *int   `json:"sample_rate"`
	BitDepth   *int   `json:"bit_depth"`
	Answered   int    `json:"answered"`
	Correct    int    `json:"correct"`
}

type DailyRow struct {
	Day      string `json:"day"` // YYYY-MM-DD in the filter time zone
	Attempts int    `json:"attempts"`
	Answered int    `json:"answered"`
	Correct  int    `json:"correct"`
}

// maxAttemptNo folds a player's 10th and later attempts into one bucket.
const maxAttemptNo = 10

// Stats aggregates finished attempts for the admin statistics tab.
func (s *Store) Stats(ctx context.Context, f StatsFilter) (*Stats, error) {
	if f.ExcludeEmails == nil {
		f.ExcludeEmails = []string{}
	}
	// $1 = days, $2 = excluded emails; every query starts from this set.
	const scope = `
		WITH a AS (
			SELECT a.* FROM attempts a JOIN users u ON u.id = a.user_id
			WHERE a.finished_at IS NOT NULL
				AND ($1::int = 0 OR a.finished_at >= now() - make_interval(days => $1::int))
				AND NOT lower(u.email) = ANY($2::text[])
		) `
	args := []any{f.Days, f.ExcludeEmails}
	st := &Stats{}

	err := s.db.QueryRow(ctx, scope+`
		SELECT count(*)::int, count(DISTINCT user_id)::int,
			coalesce(sum(total), 0)::int, coalesce(sum(score), 0)::int,
			(SELECT count(*)::int FROM attempts x JOIN users u ON u.id = x.user_id
				WHERE x.finished_at IS NULL
					AND ($1::int = 0 OR x.started_at >= now() - make_interval(days => $1::int))
					AND NOT lower(u.email) = ANY($2::text[]))
		FROM a`, args...).Scan(&st.Summary.Attempts, &st.Summary.Players,
		&st.Summary.Questions, &st.Summary.Correct, &st.Summary.Unfinished)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.Query(ctx, scope+`SELECT score, total, count(*)::int FROM a GROUP BY 1, 2 ORDER BY 2, 1`, args...)
	if err != nil {
		return nil, err
	}
	if st.Scores, err = pgx.CollectRows(rows, pgx.RowToStructByPos[ScoreBucket]); err != nil {
		return nil, err
	}

	rows, err = s.db.Query(ctx, scope+`
		SELECT q.correct_answer::int, q.user_answer::int, count(*)::int
		FROM attempt_questions q JOIN a ON a.id = q.attempt_id
		WHERE q.user_answer IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`, args...)
	if err != nil {
		return nil, err
	}
	if st.Confusion, err = pgx.CollectRows(rows, pgx.RowToStructByPos[ConfusionCell]); err != nil {
		return nil, err
	}

	rows, err = s.db.Query(ctx, scope+`
		SELECT q.position, count(*)::int, count(*) FILTER (WHERE q.user_answer = q.correct_answer)::int
		FROM attempt_questions q JOIN a ON a.id = q.attempt_id
		GROUP BY 1 ORDER BY 1`, args...)
	if err != nil {
		return nil, err
	}
	if st.ByPosition, err = pgx.CollectRows(rows, pgx.RowToStructByPos[AccuracyRow]); err != nil {
		return nil, err
	}

	// The attempt number is counted over the player's whole history, so a
	// date filter doesn't renumber it.
	rows, err = s.db.Query(ctx, scope+`
		, n AS (
			SELECT id, least(row_number() OVER (PARTITION BY user_id ORDER BY started_at), $3::int)::int AS n
			FROM attempts WHERE finished_at IS NOT NULL
		)
		SELECT n.n, sum(a.total)::int, sum(a.score)::int
		FROM a JOIN n ON n.id = a.id GROUP BY 1 ORDER BY 1`, append(args, maxAttemptNo)...)
	if err != nil {
		return nil, err
	}
	if st.ByAttemptNo, err = pgx.CollectRows(rows, pgx.RowToStructByPos[AccuracyRow]); err != nil {
		return nil, err
	}

	rows, err = s.db.Query(ctx, scope+`
		SELECT q.track_id, coalesce(t.artist, q.track_artist), coalesce(t.title, q.track_title),
			t.sample_rate, t.bit_depth,
			count(*)::int, count(*) FILTER (WHERE q.user_answer = q.correct_answer)::int
		FROM attempt_questions q JOIN a ON a.id = q.attempt_id
		LEFT JOIN tracks t ON t.id = q.track_id
		GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC`, args...)
	if err != nil {
		return nil, err
	}
	if st.ByTrack, err = pgx.CollectRows(rows, pgx.RowToStructByPos[TrackAccuracy]); err != nil {
		return nil, err
	}

	rows, err = s.db.Query(ctx, scope+`
		SELECT to_char(finished_at AT TIME ZONE $3, 'YYYY-MM-DD'), count(*)::int, sum(total)::int, sum(score)::int
		FROM a GROUP BY 1 ORDER BY 1`, append(args, f.TimeZone)...)
	if err != nil {
		return nil, err
	}
	if st.Daily, err = pgx.CollectRows(rows, pgx.RowToStructByPos[DailyRow]); err != nil {
		return nil, err
	}
	return st, nil
}

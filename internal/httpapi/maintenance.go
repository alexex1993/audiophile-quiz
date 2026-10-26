package httpapi

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
)

// LoadMaintenance reads the maintenance flag from the database; called at startup.
func (s *Server) LoadMaintenance(ctx context.Context) error {
	on, err := s.store.Maintenance(ctx)
	if err != nil {
		return err
	}
	s.maintenance.Store(on)
	return nil
}

// handleSetMaintenance turns maintenance mode on or off: JSON {"enabled": bool}.
func (s *Server) handleSetMaintenance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if readJSON(r, &req) != nil {
		writeError(w, http.StatusBadRequest, tr(r, "неверный запрос", "bad request"))
		return
	}
	if err := s.store.SetMaintenance(r.Context(), req.Enabled); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.maintenance.Store(req.Enabled)
	slog.Info("maintenance mode", "enabled", req.Enabled, "by", currentUser(r).Email)
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": req.Enabled})
}

// maintenanceGate closes the quiz to everyone but admins while maintenance
// mode is on: the page gets maintenance.html, the API a 503 with
// "maintenance": true. The admin page, Google sign-in, /api/me (which the
// admin page needs to tell admins apart) and static assets stay reachable.
func (s *Server) maintenanceGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.maintenance.Load() || !closedForMaintenance(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if u, err := s.sessionUser(r); err == nil && !u.Guest && s.cfg.IsAdmin(u.Email) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Retry-After", "600")
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":       tr(r, "на сайте идут технические работы — загляните чуть позже", "the site is under maintenance — please check back soon"),
				"maintenance": true,
			})
			return
		}
		page, err := fs.ReadFile(s.static, "maintenance.html")
		if err != nil {
			http.Error(w, "maintenance", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write(page)
	})
}

func closedForMaintenance(path string) bool {
	switch {
	case path == "/" || path == "/index.html" || path == "/auth/guest":
		return true
	case path == "/api/me" || strings.HasPrefix(path, "/api/admin/"):
		return false
	}
	return strings.HasPrefix(path, "/api/")
}

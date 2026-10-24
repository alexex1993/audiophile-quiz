package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // the runtime image has no zoneinfo; used to validate stats time zones

	"github.com/alexex/audiophile-quiz/internal/config"
	"github.com/alexex/audiophile-quiz/internal/httpapi"
	"github.com/alexex/audiophile-quiz/internal/store"
	"github.com/alexex/audiophile-quiz/web"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}

	srv := httpapi.New(cfg, st, web.Static())
	if err := srv.SyncClips(ctx); err != nil {
		return err
	}
	go srv.CleanupLoop(ctx)

	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdownCtx)
	}()

	slog.Info("listening", "addr", cfg.Addr, "base_url", cfg.BaseURL, "oauth_redirect", cfg.RedirectURL())
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

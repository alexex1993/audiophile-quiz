package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"golang.org/x/oauth2"

	"github.com/alexex/audiophile-quiz/internal/store"
)

const (
	sessionCookie  = "aq_session"
	stateCookie    = "aq_oauth_state"
	verifierCookie = "aq_oauth_verifier"
	sessionTTL     = 30 * 24 * time.Hour
	userInfoURL    = "https://openidconnect.googleapis.com/v1/userinfo"
)

type ctxKey struct{}

func currentUser(r *http.Request) *store.User {
	u, _ := r.Context().Value(ctxKey{}).(*store.User)
	return u
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	state := randomString()
	verifier := oauth2.GenerateVerifier()
	s.setCookie(w, stateCookie, state, 10*time.Minute)
	s.setCookie(w, verifierCookie, verifier, 10*time.Minute)
	url := s.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("prompt", "select_account"))
	http.Redirect(w, r, url, http.StatusFound)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	stateC, err1 := r.Cookie(stateCookie)
	verifierC, err2 := r.Cookie(verifierCookie)
	s.setCookie(w, stateCookie, "", -1)
	s.setCookie(w, verifierCookie, "", -1)
	if err1 != nil || err2 != nil ||
		subtle.ConstantTimeCompare([]byte(stateC.Value), []byte(r.URL.Query().Get("state"))) != 1 {
		http.Error(w, "Сессия входа устарела, попробуйте ещё раз.", http.StatusBadRequest)
		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tok, err := s.oauth.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(verifierC.Value))
	if err != nil {
		slog.Warn("oauth exchange", "err", err)
		http.Error(w, "Не удалось войти через Google.", http.StatusBadGateway)
		return
	}
	info, err := s.fetchUserInfo(ctx, tok)
	if err != nil {
		slog.Warn("oauth userinfo", "err", err)
		http.Error(w, "Не удалось получить профиль Google.", http.StatusBadGateway)
		return
	}
	if !info.EmailVerified {
		http.Error(w, "Email Google-аккаунта не подтверждён.", http.StatusForbidden)
		return
	}

	user, err := s.store.UpsertGoogleUser(ctx, info.Sub, info.Email, info.Name, info.Picture)
	if err != nil {
		slog.Error("upsert user", "err", err)
		http.Error(w, "Внутренняя ошибка.", http.StatusInternalServerError)
		return
	}
	token := randomString()
	if err := s.store.CreateSession(ctx, hashToken(token), user.ID, time.Now().Add(sessionTTL)); err != nil {
		slog.Error("create session", "err", err)
		http.Error(w, "Внутренняя ошибка.", http.StatusInternalServerError)
		return
	}
	s.setCookie(w, sessionCookie, token, sessionTTL)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		if err := s.store.DeleteSession(r.Context(), hashToken(c.Value)); err != nil {
			slog.Warn("delete session", "err", err)
		}
	}
	s.setCookie(w, sessionCookie, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

type googleUserInfo struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

func (s *Server) fetchUserInfo(ctx context.Context, tok *oauth2.Token) (*googleUserInfo, error) {
	resp, err := s.oauth.Client(ctx, tok).Get(userInfoURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo: status %d", resp.StatusCode)
	}
	var info googleUserInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	if info.Sub == "" || info.Email == "" {
		return nil, errors.New("userinfo: missing sub or email")
	}
	return &info, nil
}

func (s *Server) requireUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "требуется вход через Google")
			return
		}
		user, err := s.store.SessionUser(r.Context(), hashToken(c.Value))
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "требуется вход через Google")
			return
		} else if err != nil {
			writeStoreError(w, err)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, user)))
	}
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.requireUser(func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.IsAdmin(currentUser(r).Email) {
			writeError(w, http.StatusForbidden, "доступ только для администраторов")
			return
		}
		next(w, r)
	})
}

func (s *Server) setCookie(w http.ResponseWriter, name, value string, ttl time.Duration) {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.SecureCookies(),
		SameSite: http.SameSiteLaxMode,
	}
	if ttl < 0 {
		c.MaxAge = -1
	} else {
		c.MaxAge = int(ttl.Seconds())
	}
	http.SetCookie(w, c)
}

func randomString() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) []byte {
	h := sha256.Sum256([]byte(t))
	return h[:]
}

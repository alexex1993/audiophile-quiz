package httpapi

import (
	"net/http"
	"strings"
)

// langCookie is set by the language switch in the page footer.
const langCookie = "lang"

// isRussian picks the response language the same way common.js does: the
// language switch cookie if set, otherwise Russian only when it is the
// browser's first preference, and English for everyone else.
func isRussian(r *http.Request) bool {
	if c, err := r.Cookie(langCookie); err == nil && (c.Value == "ru" || c.Value == "en") {
		return c.Value == "ru"
	}
	first, _, _ := strings.Cut(r.Header.Get("Accept-Language"), ",")
	first, _, _ = strings.Cut(strings.TrimSpace(first), ";")
	tag := strings.ToLower(first)
	return tag == "ru" || strings.HasPrefix(tag, "ru-")
}

// tr returns the message in the request's language.
func tr(r *http.Request, ru, en string) string {
	if isRussian(r) {
		return ru
	}
	return en
}

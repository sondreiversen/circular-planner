// Package favicon serves the site favicon (default embedded SVG, or an
// admin-uploaded custom one stored in DATA_DIR) and exposes admin endpoints
// to upload / reset / inspect it.
//
// Storage layout:
//   - Custom file bytes:   {DATA_DIR}/favicon.bin
//   - Content-Type:        app_settings row, key "custom_favicon_content_type"
//
// The favicon serve route is unauthenticated and registered separately from
// /api/*; the admin routes require admin.
package favicon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"

	"planner/internal/config"
	"planner/internal/db"
	"planner/internal/settings"
)

const (
	settingsKey     = "custom_favicon_content_type"
	customFilename  = "favicon.bin"
	maxUploadBytes  = 1 << 20 // 1 MiB
	defaultMIMEType = "image/svg+xml"
)

// allowedTypes is the set of content-types we accept for custom upload.
// SVG is preferred for its small size; PNG/ICO are accepted for legacy use.
var allowedTypes = map[string]bool{
	"image/svg+xml":              true,
	"image/png":                  true,
	"image/x-icon":               true,
	"image/vnd.microsoft.icon":   true,
	"image/jpeg":                 true,
	"image/webp":                 true,
	"image/gif":                  true,
}

// Handler serves the favicon endpoints. The default favicon bytes are read
// via a closure (typically backed by go:embed) supplied by the caller, so
// this package doesn't import main's embed.
type Handler struct {
	db          *db.DB
	cfg         *config.Config
	readDefault func() ([]byte, error)
}

// NewHandler wires the favicon handler.
//
// readDefault should return the bytes of the embedded default favicon
// (typically from go:embed). Passed in as a closure so this package
// doesn't need to import main's embed.
func NewHandler(database *db.DB, cfg *config.Config, readDefault func() ([]byte, error)) *Handler {
	return &Handler{db: database, cfg: cfg, readDefault: readDefault}
}

// RegisterPublic mounts the unauthenticated favicon serve route on mux.
// Browsers auto-request /favicon.ico unless a <link rel="icon"> overrides it,
// so register all three common extensions and route them all here.
func (h *Handler) RegisterPublic(mux *http.ServeMux) {
	mux.HandleFunc("GET /favicon.svg", h.Serve)
	mux.HandleFunc("GET /favicon.ico", h.Serve)
	mux.HandleFunc("GET /favicon.png", h.Serve)
}

// Serve sends the custom favicon if one is set; otherwise the embedded default.
//
// Cache strategy: short (300s) Cache-Control so admin changes propagate quickly,
// with an ETag for conditional requests.
func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {
	contentType, body, err := h.currentFavicon(r)
	if err != nil {
		http.Error(w, "favicon unavailable", http.StatusInternalServerError)
		return
	}

	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:8]) + `"`
	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("ETag", etag)
	_, _ = w.Write(body)
}

// currentFavicon returns (contentType, bytes, err) — preferring the custom
// file when present.
func (h *Handler) currentFavicon(r *http.Request) (string, []byte, error) {
	customPath := h.customPath()
	if customPath != "" {
		if data, err := os.ReadFile(customPath); err == nil {
			ct := settings.GetString(r.Context(), h.db, settingsKey, defaultMIMEType)
			return ct, data, nil
		}
	}

	data, err := h.readDefault()
	if err != nil {
		return "", nil, err
	}
	return defaultMIMEType, data, nil
}

// customPath returns the on-disk path for the custom favicon, or "" if
// DATA_DIR is unset (which would be unusual — config always provides one).
func (h *Handler) customPath() string {
	if h.cfg == nil || h.cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(h.cfg.DataDir, customFilename)
}

// --- Admin endpoints ---

// GetStatus returns whether a custom favicon is currently set.
//
//	{ "custom": true, "contentType": "image/svg+xml" }
func (h *Handler) GetStatus(w http.ResponseWriter, r *http.Request) {
	custom := false
	contentType := defaultMIMEType
	if p := h.customPath(); p != "" {
		if _, err := os.Stat(p); err == nil {
			custom = true
			contentType = settings.GetString(r.Context(), h.db, settingsKey, defaultMIMEType)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"custom":      custom,
		"contentType": contentType,
	})
}

// Upload accepts a multipart form with field "favicon" and stores it as the
// custom favicon. Replaces any previous custom favicon atomically.
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	// Cap the in-memory parse buffer; anything larger spills to a temp file.
	// We also enforce a hard size cap below.
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid multipart upload")
		return
	}

	file, header, err := r.FormFile("favicon")
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Missing 'favicon' file field")
		return
	}
	defer file.Close()

	if header.Size > maxUploadBytes {
		jsonError(w, http.StatusRequestEntityTooLarge, "File too large (max 1 MiB)")
		return
	}

	// Read the full body into memory so we can sniff and write atomically.
	buf, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "Failed to read upload")
		return
	}
	if len(buf) > maxUploadBytes {
		jsonError(w, http.StatusRequestEntityTooLarge, "File too large (max 1 MiB)")
		return
	}
	if len(buf) == 0 {
		jsonError(w, http.StatusBadRequest, "Empty file")
		return
	}

	contentType := sniffType(buf, header)
	if !allowedTypes[contentType] {
		jsonError(w, http.StatusUnsupportedMediaType,
			"Unsupported file type. Use SVG, PNG, ICO, JPEG, WEBP, or GIF.")
		return
	}

	dataDir := h.cfg.DataDir
	if dataDir == "" {
		jsonError(w, http.StatusInternalServerError, "DATA_DIR not configured")
		return
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to create data dir")
		return
	}

	// Atomic write: tmp file in the same dir, then rename.
	dst := filepath.Join(dataDir, customFilename)
	tmp, err := os.CreateTemp(dataDir, "favicon-*.tmp")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to write file")
		return
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op if already renamed

	if _, err := tmp.Write(buf); err != nil {
		_ = tmp.Close()
		jsonError(w, http.StatusInternalServerError, "Failed to write file")
		return
	}
	if err := tmp.Close(); err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to close file")
		return
	}
	if err := os.Rename(tmpName, dst); err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to swap file")
		return
	}

	if err := settings.SetString(r.Context(), h.db, settingsKey, contentType); err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to persist content-type")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"custom":      true,
		"contentType": contentType,
	})
}

// Reset removes the custom favicon, restoring the embedded default.
func (h *Handler) Reset(w http.ResponseWriter, r *http.Request) {
	p := h.customPath()
	if p != "" {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			jsonError(w, http.StatusInternalServerError, "Failed to delete file")
			return
		}
	}
	_ = settings.Delete(r.Context(), h.db, settingsKey)

	writeJSON(w, http.StatusOK, map[string]any{
		"custom":      false,
		"contentType": defaultMIMEType,
	})
}

// sniffType prefers the client-declared Content-Type from the form header
// (when on the allow-list), falling back to http.DetectContentType plus a
// small SVG override (DetectContentType returns text/xml for unprefixed SVG).
func sniffType(body []byte, header *multipart.FileHeader) string {
	if declared := header.Header.Get("Content-Type"); allowedTypes[declared] {
		return declared
	}
	// SVG often sniffs as text/xml because Go's detector keys on the XML decl.
	if len(body) > 5 && (string(body[:5]) == "<?xml" || string(body[:4]) == "<svg") {
		return "image/svg+xml"
	}
	sniffed := http.DetectContentType(body)
	// Strip any "; charset=…" suffix.
	for i, c := range sniffed {
		if c == ';' {
			return sniffed[:i]
		}
	}
	return sniffed
}

// --- json helpers (duplicated locally to avoid importing admin) ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

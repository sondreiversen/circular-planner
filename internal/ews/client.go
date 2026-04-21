package ews

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Config is the connection configuration for a single EWS request.
type Config struct {
	ServerURL           string // e.g. "https://mail.corp.com/ews/exchange.asmx"
	Username            string // "DOMAIN\\user" or "user@domain.com"
	Password            string
	AuthMethod          string // "ntlm" or "basic"
	AllowSelfSignedCert bool
}

// Query is the date range we want events for.
type Query struct {
	StartDate string // YYYY-MM-DD
	EndDate   string // YYYY-MM-DD
	MaxItems  int
}

// ImportedEvent is a parsed, frontend-ready calendar event. JSON tags match the
// Node backend's response shape so the frontend is branch-agnostic.
type ImportedEvent struct {
	Subject     string   `json:"subject"`
	Description string   `json:"description"`
	StartDate   string   `json:"startDate"`
	EndDate     string   `json:"endDate"`
	Location    string   `json:"location"`
	Categories  []string `json:"categories"`
	IsAllDay    bool     `json:"isAllDay"`
}

// Result is what the route handler returns to the client.
type Result struct {
	Events     []ImportedEvent `json:"events"`
	TotalFound int             `json:"totalFound"`
	Errors     []string        `json:"errors"`
}

const requestTimeout = 30 * time.Second

// retryDelays are the wait durations between successive attempts (1s, 3s, 8s).
// Up to len(retryDelays)+1 total attempts.
var retryDelays = []time.Duration{1 * time.Second, 3 * time.Second, 8 * time.Second}

// isTransientError returns true for errors that may succeed on retry.
func isTransientError(err error) bool {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "connection reset"),
		strings.Contains(msg, "no such host"),
		strings.Contains(msg, "EOF"),
		strings.Contains(msg, "socket hang up"),
		strings.Contains(msg, "timed out"),
		strings.Contains(msg, "HTTP 5"), // 5xx
		strings.Contains(msg, "HTTP 429"),
		strings.Contains(msg, "NTLM negotiate failed: expected 401, got 5"):
		return true
	}
	return false
}

// retryWithBackoff calls fn up to len(retryDelays)+1 times, waiting between attempts.
// It only retries if isTransientError returns true for the returned error.
func retryWithBackoff(fn func() error) error {
	var lastErr error
	for attempt := 0; attempt <= len(retryDelays); attempt++ {
		if err := fn(); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if attempt == len(retryDelays) || !isTransientError(lastErr) {
			return lastErr
		}
		time.Sleep(retryDelays[attempt])
	}
	return lastErr
}

// ProgressCallback is called after each monthly chunk completes.
type ProgressCallback func(completed, total int)

// buildMonthlyChunks splits [startDate, endDate] into per-month Query slices.
func buildMonthlyChunks(startDate, endDate string) []Query {
	start, err1 := time.Parse("2006-01-02", startDate)
	end, err2 := time.Parse("2006-01-02", endDate)
	if err1 != nil || err2 != nil || !start.Before(end.AddDate(0, 0, 1)) {
		return []Query{{StartDate: startDate, EndDate: endDate}}
	}

	var chunks []Query
	cursor := start
	for !cursor.After(end) {
		chunkStart := cursor.Format("2006-01-02")
		// Last day of current month
		nextMonth := time.Date(cursor.Year(), cursor.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		lastOfMonth := nextMonth.AddDate(0, 0, -1)
		var chunkEnd time.Time
		if lastOfMonth.Before(end) {
			chunkEnd = lastOfMonth
		} else {
			chunkEnd = end
		}
		chunks = append(chunks, Query{StartDate: chunkStart, EndDate: chunkEnd.Format("2006-01-02")})
		cursor = nextMonth
	}
	if len(chunks) == 0 {
		return []Query{{StartDate: startDate, EndDate: endDate}}
	}
	return chunks
}

func buildSoapEnvelope(q Query) string {
	max := q.MaxItems
	if max <= 0 {
		max = 500
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:Location"/>
          <t:FieldURI FieldURI="item:Categories"/>
          <t:FieldURI FieldURI="calendar:IsAllDayEvent"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView StartDate="%sT00:00:00Z" EndDate="%sT23:59:59Z" MaxEntriesReturned="%d"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`, q.StartDate, q.EndDate, max)
}

func newClient(cfg Config) *http.Client {
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.AllowSelfSignedCert, // #nosec G402 — opt-in for air-gapped self-signed certs
			MinVersion:         tls.VersionTLS12,
		},
		// Keep-alive is required so the NTLM 3-leg handshake reuses the TCP connection.
		DisableKeepAlives:   false,
		MaxIdleConns:        2,
		MaxIdleConnsPerHost: 2,
	}
	return &http.Client{Transport: tr}
}

func fetchWithNTLM(ctx context.Context, cfg Config, soapBody string) (string, error) {
	creds := ParseCredentials(cfg.Username, cfg.Password)
	client := newClient(cfg)
	defer client.CloseIdleConnections()

	// Step 1: Type 1 (Negotiate)
	type1 := base64Std(CreateType1Message(creds.Domain))
	req1, _ := http.NewRequestWithContext(ctx, "POST", cfg.ServerURL, nil)
	req1.Header.Set("Content-Type", "text/xml; charset=utf-8")
	req1.Header.Set("Authorization", "NTLM "+type1)
	req1.Header.Set("Content-Length", "0")

	resp1, err := client.Do(req1)
	if err != nil {
		return "", err
	}
	_, _ = io.Copy(io.Discard, resp1.Body)
	resp1.Body.Close()

	if resp1.StatusCode != http.StatusUnauthorized {
		return "", fmt.Errorf("NTLM negotiate failed: expected 401, got %d", resp1.StatusCode)
	}

	// Step 2: parse Type 2 from WWW-Authenticate
	challenge := ""
	for _, h := range resp1.Header.Values("WWW-Authenticate") {
		if strings.HasPrefix(strings.ToUpper(h), "NTLM ") && len(h) > 5 {
			challenge = strings.TrimSpace(h[5:])
			break
		}
	}
	if challenge == "" {
		return "", errors.New("server did not return NTLM challenge — NTLM may not be enabled")
	}
	t2, err := ParseType2Message(challenge)
	if err != nil {
		return "", fmt.Errorf("NTLM challenge parse: %w", err)
	}

	// Step 3: Type 3 (Authenticate) with the SOAP body
	type3 := base64Std(CreateType3Message(creds, t2))
	req3, _ := http.NewRequestWithContext(ctx, "POST", cfg.ServerURL, strings.NewReader(soapBody))
	req3.Header.Set("Content-Type", "text/xml; charset=utf-8")
	req3.Header.Set("Authorization", "NTLM "+type3)

	resp3, err := client.Do(req3)
	if err != nil {
		return "", err
	}
	defer resp3.Body.Close()

	body, _ := io.ReadAll(resp3.Body)
	if resp3.StatusCode == http.StatusUnauthorized {
		return "", errors.New("NTLM authentication failed — check username, password, and domain")
	}
	if resp3.StatusCode != http.StatusOK {
		return "", fmt.Errorf("EWS returned HTTP %d: %s", resp3.StatusCode, truncate(string(body), 200))
	}
	return string(body), nil
}

func fetchWithBasic(ctx context.Context, cfg Config, soapBody string) (string, error) {
	client := newClient(cfg)
	defer client.CloseIdleConnections()

	req, _ := http.NewRequestWithContext(ctx, "POST", cfg.ServerURL, strings.NewReader(soapBody))
	req.Header.Set("Content-Type", "text/xml; charset=utf-8")
	req.SetBasicAuth(cfg.Username, cfg.Password)

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusUnauthorized {
		return "", errors.New("Basic authentication failed — check username and password")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("EWS returned HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return string(body), nil
}

// fetchPage fetches one date-range chunk with per-attempt 30s timeout + retry.
func fetchPage(parentCtx context.Context, cfg Config, chunk Query) ([]ImportedEvent, []string, error) {
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || u.Scheme != "https" {
		return nil, nil, errors.New("serverUrl must be a valid https URL")
	}

	var events []ImportedEvent
	var errs []string

	ferr := retryWithBackoff(func() error {
		ctx, cancel := context.WithTimeout(parentCtx, requestTimeout)
		defer cancel()

		soap := buildSoapEnvelope(chunk)

		var xmlResp string
		var err error
		if strings.EqualFold(cfg.AuthMethod, "basic") {
			xmlResp, err = fetchWithBasic(ctx, cfg, soap)
		} else {
			xmlResp, err = fetchWithNTLM(ctx, cfg, soap)
		}
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errors.New("request timed out after 30s")
			}
			return err
		}

		if fault := ExtractFaultMessage(xmlResp); fault != "" {
			return fmt.Errorf("Exchange returned an error: %s", fault)
		}

		raw, parseErrs := ExtractCalendarItems(xmlResp)
		events = make([]ImportedEvent, 0, len(raw))
		for _, r := range raw {
			events = append(events, mapItem(r))
		}
		errs = parseErrs
		return nil
	})
	return events, errs, ferr
}

// FetchCalendarEvents performs the EWS FindItem/CalendarView request and returns
// parsed events. Credentials live only in memory for the duration of the call.
// The date range is split into monthly chunks; each chunk is retried independently.
// onProgress is called after each chunk completes (may be nil).
func FetchCalendarEvents(parentCtx context.Context, cfg Config, q Query, onProgress ...ProgressCallback) (Result, error) {
	// Validate the URL early so callers get a clean error rather than a 404/DNS failure.
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || u.Scheme != "https" {
		return Result{}, errors.New("serverUrl must be a valid https URL")
	}
	_ = u

	chunks := buildMonthlyChunks(q.StartDate, q.EndDate)
	var cb ProgressCallback
	if len(onProgress) > 0 {
		cb = onProgress[0]
	}
	if cb != nil {
		cb(0, len(chunks))
	}

	var allEvents []ImportedEvent
	var allErrs []string

	for i, chunk := range chunks {
		evts, errs, err := fetchPage(parentCtx, cfg, chunk)
		if err != nil {
			return Result{}, err
		}
		allEvents = append(allEvents, evts...)
		allErrs = append(allErrs, errs...)
		if cb != nil {
			cb(i+1, len(chunks))
		}
	}

	return Result{
		Events:     allEvents,
		TotalFound: len(allEvents),
		Errors:     allErrs,
	}, nil
}

// toDateStr converts an Exchange ISO datetime to YYYY-MM-DD (UTC date portion).
func toDateStr(iso string) string {
	if iso == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		if len(iso) >= 10 {
			return iso[:10]
		}
		return iso
	}
	return t.UTC().Format("2006-01-02")
}

func mapItem(r RawCalendarItem) ImportedEvent {
	startDate := toDateStr(r.Start)
	endDate := toDateStr(r.End)

	// All-day events: Exchange uses an exclusive end (Start=Apr15, End=Apr16
	// for a 1-day event). Subtract one day for an inclusive range.
	if r.IsAllDay && endDate > startDate {
		if t, err := time.Parse("2006-01-02", endDate); err == nil {
			endDate = t.AddDate(0, 0, -1).Format("2006-01-02")
		}
	}
	if endDate < startDate {
		endDate = startDate
	}

	description := r.Body
	if r.Location != "" {
		if description != "" {
			description = "Location: " + r.Location + "\n\n" + description
		} else {
			description = "Location: " + r.Location
		}
	}
	return ImportedEvent{
		Subject:     truncate(r.Subject, 200),
		Description: truncate(description, 2000),
		StartDate:   startDate,
		EndDate:     endDate,
		Location:    r.Location,
		Categories:  r.Categories,
		IsAllDay:    r.IsAllDay,
	}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func base64Std(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}

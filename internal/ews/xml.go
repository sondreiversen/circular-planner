// Package ews implements a minimal Exchange Web Services client used to
// import calendar events from an on-premises Exchange server.
//
// Responses are extracted with targeted regexes rather than an XML parser —
// the EWS response shape is predictable and we only need a handful of fields.
package ews

import (
	"regexp"
	"strings"
)

// RawCalendarItem holds the fields we extract from a single <t:CalendarItem>.
type RawCalendarItem struct {
	Subject    string
	Start      string // ISO datetime from Exchange
	End        string
	Location   string
	Body       string
	Categories []string
	IsAllDay   bool
}

var xmlEntities = strings.NewReplacer(
	"&amp;", "&",
	"&lt;", "<",
	"&gt;", ">",
	"&quot;", "\"",
	"&apos;", "'",
)

func decodeXMLEntities(s string) string {
	return xmlEntities.Replace(s)
}

var (
	reBr       = regexp.MustCompile(`(?i)<br\s*/?>`)
	reCloseP   = regexp.MustCompile(`(?i)</p>`)
	reAnyTag   = regexp.MustCompile(`<[^>]+>`)
	reBlanks   = regexp.MustCompile(`\n{3,}`)
	reCalItem  = regexp.MustCompile(`(?s)<(?:t:)?CalendarItem[\s>]([\s\S]*?)</(?:t:)?CalendarItem>`)
	reStringEl = regexp.MustCompile(`(?s)<(?:t:)?String[^>]*>([\s\S]*?)</(?:t:)?String>`)
)

func stripHTMLTags(s string) string {
	s = reBr.ReplaceAllString(s, "\n")
	s = reCloseP.ReplaceAllString(s, "\n")
	s = reAnyTag.ReplaceAllString(s, "")
	s = reBlanks.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// extractElement pulls the text content of a single element by local tag name,
// tolerating the `t:` namespace prefix used by Exchange.
func extractElement(block, tag string) string {
	re := regexp.MustCompile(`(?is)<(?:t:)?` + regexp.QuoteMeta(tag) + `[^>]*>([\s\S]*?)</(?:t:)?` + regexp.QuoteMeta(tag) + `>`)
	m := re.FindStringSubmatch(block)
	if m == nil {
		return ""
	}
	return decodeXMLEntities(strings.TrimSpace(m[1]))
}

func extractCategories(block string) []string {
	cat := extractElement(block, "Categories")
	if cat == "" {
		return nil
	}
	matches := reStringEl.FindAllStringSubmatch(cat, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, decodeXMLEntities(strings.TrimSpace(m[1])))
	}
	return out
}

// ExtractCalendarItems parses all <t:CalendarItem> blocks from an EWS FindItem response.
func ExtractCalendarItems(xml string) ([]RawCalendarItem, []string) {
	var items []RawCalendarItem
	var errs []string

	matches := reCalItem.FindAllStringSubmatch(xml, -1)
	for i, m := range matches {
		idx := i + 1
		block := m[1]
		subject := extractElement(block, "Subject")
		start := extractElement(block, "Start")
		end := extractElement(block, "End")

		if subject == "" && start == "" {
			errs = append(errs, "Item "+itoa(idx)+": missing Subject and Start")
			continue
		}

		body := stripHTMLTags(extractElement(block, "Body"))
		items = append(items, RawCalendarItem{
			Subject:    subject,
			Start:      start,
			End:        end,
			Location:   extractElement(block, "Location"),
			Body:       body,
			Categories: extractCategories(block),
			IsAllDay:   strings.EqualFold(extractElement(block, "IsAllDayEvent"), "true"),
		})
	}
	return items, errs
}

// ExtractFaultMessage returns a SOAP fault / EWS error message if one is present.
func ExtractFaultMessage(xml string) string {
	if f := extractElement(xml, "faultstring"); f != "" {
		return f
	}
	if m := extractElement(xml, "MessageText"); m != "" {
		return m
	}
	if rc := extractElement(xml, "ResponseCode"); rc != "" && rc != "NoError" {
		return rc
	}
	return ""
}

// itoa avoids a strconv import at package scope (keeps the file self-contained).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

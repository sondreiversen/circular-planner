package db

import "context"

// contextKey is the unexported type for context keys in this package.
type contextKey int

const requestIDKey contextKey = 0

// WithRequestID returns a new context carrying a request ID for slow-query logging.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestIDFrom extracts the request ID from ctx, returning "" if absent.
func RequestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey).(string); ok {
		return v
	}
	return ""
}

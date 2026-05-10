package middleware

import (
	"sync"
	"time"
)

const userCacheTTL = 30 * time.Second

type cachedUser struct {
	isAdmin  bool
	fullName string
	expires  time.Time
}

var (
	userCache   = make(map[int]cachedUser)
	userCacheMu sync.RWMutex
)

func userCacheGet(id int) (cachedUser, bool) {
	userCacheMu.RLock()
	cu, ok := userCache[id]
	userCacheMu.RUnlock()
	if !ok || time.Now().After(cu.expires) {
		return cachedUser{}, false
	}
	return cu, true
}

func userCachePut(id int, isAdmin bool, fullName string) {
	userCacheMu.Lock()
	userCache[id] = cachedUser{
		isAdmin:  isAdmin,
		fullName: fullName,
		expires:  time.Now().Add(userCacheTTL),
	}
	userCacheMu.Unlock()
}

// UserCacheInvalidate removes the cached entry for the given user ID.
// Call this after admin actions that change is_admin or delete a user so the
// change takes effect on the user's next request rather than waiting for the TTL.
func UserCacheInvalidate(id int) {
	userCacheMu.Lock()
	delete(userCache, id)
	userCacheMu.Unlock()
}

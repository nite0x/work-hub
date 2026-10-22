package model

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

func NewID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func Now() string { return time.Now().UTC().Format(time.RFC3339) }

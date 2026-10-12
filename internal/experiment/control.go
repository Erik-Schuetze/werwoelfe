package experiment

import (
	"context"
	"encoding/json"
	"os"
	"time"
)

// pausePollInterval is how often a paused run re-reads the control file. One second is fast
// enough that a human sees a pause take effect within a turn — one stat and one small read per
// second is cheap — while keeping the polling loop off the busy-wait path.
const pausePollInterval = time.Second

// controlFile is the JSON the operator console writes onto the shared volume. It is a
// forward-compatible contract: unknown fields are ignored, so the console may add fields
// without breaking an older engine.
type controlFile struct {
	SchemaVersion int    `json:"schema_version"`
	Paused        bool   `json:"paused"`
	RequestedAt   string `json:"requested_at"`
}

// PauseControl is a cooperative pause gate. It is not a lock: the engine polls the control file
// the console writes and blocks between turns while the file says paused. It fails open — an
// empty path, a missing or unreadable file, or malformed JSON all mean "not paused" — so a
// truncated or half-written control file can never strand a run forever.
//
// A nil *PauseControl and one with an empty path are both no-ops, so the standalone CLI is
// byte-for-byte unchanged when the feature is disabled.
type PauseControl struct {
	path     string
	interval time.Duration
}

// NewPauseControl returns a gate reading the control file at path. An empty path disables the
// feature: Wait then returns immediately. The poll interval defaults to pausePollInterval.
func NewPauseControl(path string) *PauseControl {
	return &PauseControl{path: path, interval: pausePollInterval}
}

// Wait blocks while the control file says the run is paused, and returns nil as soon as it is
// missing, unreadable, malformed, or names paused=false. It returns ctx.Err() if the context is
// cancelled while paused, so a paused run still honours the operator's -timeout.
//
// The receiver may be nil: a nil gate is a no-op, matching the house idiom in diagnostics.go.
func (c *PauseControl) Wait(ctx context.Context) error {
	if c == nil || c.path == "" {
		return nil
	}
	interval := c.interval
	if interval <= 0 {
		interval = pausePollInterval
	}
	for {
		paused, err := c.paused()
		if err != nil || !paused {
			return nil
		}
		ticker := time.NewTicker(interval)
		select {
		case <-ctx.Done():
			ticker.Stop()
			return ctx.Err()
		case <-ticker.C:
			ticker.Stop()
		}
	}
}

// paused reads and parses the control file. Any read or parse fault is reported as not-paused,
// which is the fail-open policy: a missing, unreadable or malformed file must never hold a run.
func (c *PauseControl) paused() (bool, error) {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return false, err
	}
	var control controlFile
	if err := json.Unmarshal(data, &control); err != nil {
		return false, err
	}
	return control.Paused, nil
}

package experiment

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// failureResponseLimit and failureErrorLimit bound one record so a runaway or looping model
	// response cannot bloat the diagnostic file. The values are generous enough to hold a full
	// action JSON payload and its parse fault.
	failureResponseLimit = 4000
	failureErrorLimit    = 500

	// failureLogName is the sibling file, written next to the operator event stream so it lands
	// in the mounted output directory and survives the container exiting and --rm.
	failureLogName = "model-failures.ndjson"
)

// FailureRecord captures one model response that failed to parse or validate, or one failed
// non-turn call such as cast generation. It is deliberately separate from the event stream and
// the sanitized result: it is an operator-only diagnostic that may hold private reasoning, so it
// is never ingested into the operator database and never written into game-result.json.
//
// A cast_generation record whose Error begins "partial cast:" is not a failed run: the run
// proceeded and only the named players fell back to their configured personality, so it is a
// degradation to read, never a fatal fault. Any other cast_generation record means the whole cast
// fell back.
type FailureRecord struct {
	At time.Time `json:"at"`
	// Phase is the game phase for a rejected action, or a step name such as "cast_generation"
	// for a call that is not a player's turn.
	Phase string `json:"phase"`
	// Player is the acting player's id, or empty for a step that is not a single player's.
	Player  string `json:"player"`
	Attempt int    `json:"attempt"`
	// Error is the exact rejection or fault; Response is the raw completion, empty when the call
	// itself failed before any text was returned.
	Error    string `json:"error"`
	Response string `json:"response"`
}

// ResponseLog appends raw rejected responses to a diagnostic file so a failed run can be
// explained afterwards. Every write is best-effort: an error is swallowed and never fails a run,
// and a nil *ResponseLog is a no-op so tests that do not care need not configure one.
type ResponseLog struct {
	mu     sync.Mutex
	writer io.Writer
	closer io.Closer
}

// NewResponseLog derives the diagnostic location from the operator event path so the log lands in
// the same mounted output directory. An empty path (the event stream is disabled) falls back to
// stderr. A directory the process cannot write is also a fallback to stderr, because a diagnostic
// that cannot be written must not take the run down with it.
func NewResponseLog(eventPath string) *ResponseLog {
	if eventPath == "" {
		return &ResponseLog{writer: os.Stderr}
	}
	path := filepath.Join(filepath.Dir(eventPath), failureLogName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return &ResponseLog{writer: os.Stderr}
	}
	return &ResponseLog{writer: file, closer: file}
}

// Record appends one failure record. It never returns an error: a logging failure is swallowed so
// that the run's own outcome is unchanged. Writes are unbuffered, so a record is on disk before
// the caller can os.Exit on the failure path.
func (l *ResponseLog) Record(record FailureRecord) {
	if l == nil {
		return
	}
	if record.At.IsZero() {
		record.At = time.Now().UTC()
	}
	record.Response = truncateRunes(record.Response, failureResponseLimit)
	record.Error = truncateRunes(record.Error, failureErrorLimit)
	data, err := json.Marshal(record)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.writer == nil {
		return
	}
	if _, err := l.writer.Write(append(data, '\n')); err != nil {
		// Stop trying after the first failure rather than repeating a doomed write per action.
		l.writer = nil
	}
}

// Close releases the underlying file, if any. Like Record it is best-effort; the returned error is
// for callers that want it but a failure to close must never fail a run.
func (l *ResponseLog) Close() error {
	if l == nil || l.closer == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	err := l.closer.Close()
	l.closer = nil
	l.writer = nil
	return err
}

// truncateRunes clips text to limit runes so a diagnostic record stays bounded.
func truncateRunes(text string, limit int) string {
	if limit <= 0 || utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}

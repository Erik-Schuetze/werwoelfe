package experiment

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestPauseControlDisabledIsNoOp proves both disabled forms — an empty path and a nil receiver —
// return nil immediately, so the standalone CLI never blocks when the feature is off.
func TestPauseControlDisabledIsNoOp(t *testing.T) {
	if err := NewPauseControl("").Wait(context.Background()); err != nil {
		t.Fatalf("empty path Wait = %v, want nil", err)
	}
	var nilControl *PauseControl
	if err := nilControl.Wait(context.Background()); err != nil {
		t.Fatalf("nil receiver Wait = %v, want nil", err)
	}
}

// TestPauseControlMissingFileFailsOpen proves a control file that does not exist yet is not
// treated as paused: the run proceeds.
func TestPauseControlMissingFileFailsOpen(t *testing.T) {
	control := NewPauseControl(filepath.Join(t.TempDir(), "absent.json"))
	if err := control.Wait(context.Background()); err != nil {
		t.Fatalf("missing file Wait = %v, want nil", err)
	}
}

// TestPauseControlMalformedJSONFailsOpen proves a truncated or malformed control file is not
// treated as paused: a half-written file must never strand a run forever.
func TestPauseControlMalformedJSONFailsOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control.json")
	if err := os.WriteFile(path, []byte(`{"paused":true`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewPauseControl(path).Wait(context.Background()); err != nil {
		t.Fatalf("malformed JSON Wait = %v, want nil", err)
	}
}

// TestPauseControlPausedHonoursCancellation proves that a paused gate returns ctx.Err() once the
// context is cancelled, so a paused run still honours the operator's -timeout.
func TestPauseControlPausedHonoursCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":1,"paused":true,"requested_at":"2026-10-12T00:00:00Z"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := NewPauseControl(path).Wait(ctx); err != context.Canceled {
		t.Fatalf("cancelled paused Wait = %v, want context.Canceled", err)
	}
}

// TestPauseControlMissingFileDoesNotBlock proves the loop does not spin when the file never
// appears: an unreadable path returns immediately rather than polling forever.
func TestPauseControlUnreadablePathFailsOpen(t *testing.T) {
	if err := NewPauseControl(t.TempDir()).Wait(context.Background()); err != nil {
		t.Fatalf("directory-as-file Wait = %v, want nil", err)
	}
}

package experiment

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/eschuetze/werwoelfe/internal/game"
)

func TestEventStreamIncludesPrivateEventsWithRecipients(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.ndjson")
	stream, err := NewEventStream(path)
	if err != nil {
		t.Fatal(err)
	}
	stream.WriteEvent(game.Event{
		Sequence: 1, At: time.Now(), Kind: "player_removed", Visibility: game.Public,
		PlayerID: "p3", RevealedRole: game.Villager, Message: "visible",
	})
	stream.WriteEvent(game.Event{Sequence: 2, At: time.Now(), Kind: "private", Visibility: game.Private, Recipients: []string{"p1", "p2"}, Message: "secret"})
	stream.WriteFailure(os.ErrNotExist)
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	records := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(records) != 3 {
		t.Fatalf("record count = %d, want 3", len(records))
	}
	var event StreamRecord
	if err := json.Unmarshal([]byte(records[0]), &event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "event" || event.Event == nil || event.Event.Message != "visible" ||
		event.Event.PlayerID != "p3" || event.Event.RevealedRole != game.Villager {
		t.Fatalf("event record = %#v", event)
	}
	var privateEvent StreamRecord
	if err := json.Unmarshal([]byte(records[1]), &privateEvent); err != nil {
		t.Fatal(err)
	}
	if privateEvent.Event == nil || privateEvent.Event.Visibility != game.Private ||
		privateEvent.Event.Message != "secret" || !equalStrings(privateEvent.Event.Recipients, []string{"p1", "p2"}) {
		t.Fatalf("private event record = %#v", privateEvent)
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

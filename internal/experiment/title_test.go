package experiment

import (
	"context"
	"errors"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/eschuetze/werwoelfe/internal/config"
	"github.com/eschuetze/werwoelfe/internal/game"
	"github.com/eschuetze/werwoelfe/internal/model"
)

// TestTitleSpoilerGateRejectsAndAccepts is the safety property the naming call rests on:
// the namer sees the whole run, so the gate — not the prompt — is what keeps the outcome
// out of the title. A spoiler-y title must be rejected; a benign one must pass.
func TestTitleSpoilerGateRejectsAndAccepts(t *testing.T) {
	eliminated := []string{"Ada", "Curie"}
	rejected := []struct {
		name  string
		title string
	}{
		{name: "outcome verb", title: "The Werewolves Win"},
		{name: "outcome noun", title: "A Quiet Victory"},
		{name: "case-insensitive token", title: "the WINNER takes all"},
		{name: "plural of winner", title: "The Winners Take All"},
		{name: "plural of loser", title: "Twilight of the Losers"},
		{name: "inflected survive", title: "Who Survives the Night"},
		{name: "plural of execution", title: "The Executions"},
		{name: "inflected winning", title: "Two Weeks of Winning"},
		{name: "inflected defeated", title: "Defeated at Dusk"},
		{name: "guilty", title: "Guilty as Charged"},
		{name: "names an eliminated player", title: "Ada's Long Walk"},
		{name: "empty", title: "   "},
		{name: "over the cap", title: strings.Repeat("q", titleLengthLimit+1)},
	}
	for _, test := range rejected {
		if reason := titleSpoiler(test.title, eliminated, titleLengthLimit); reason == "" {
			t.Fatalf("gate accepted a spoiler-y title (%s): %q", test.name, test.title)
		}
	}
	accepted := []string{
		"Ten Voices at Dusk",
		"Millers Hollow — eight voices, three nights",
		"A Badge and a Whisper",
		// Lookalikes: a longer word that merely contains a stem must still pass, so the
		// controlled suffix sets did not reintroduce substring false positives.
		"Wonder in the Hollow", // "won" inside "wonder"
		"Winter's Hold",        // "win" inside "winter"
		"The Long Weekend",     // "end" inside "weekend"
		"Over the Table",       // "over" is no longer a token: too often benign
	}
	for _, title := range accepted {
		if reason := titleSpoiler(title, eliminated, titleLengthLimit); reason != "" {
			t.Fatalf("gate rejected a benign title %q: %s", title, reason)
		}
	}
}

// TestFallbackTitleIsSpoilerFree proves the deterministic fallback — the last line of
// defence when naming fails, is disabled, or is rejected twice — names no player and
// contains no outcome token, across the whole range of player counts and night counts.
func TestFallbackTitleIsSpoilerFree(t *testing.T) {
	playerNames := []string{"Ada", "Babbage", "Curie", "Dijkstra", "Edsger", "Franklin", "Hooper", "Ian"}
	for players := 0; players <= 18; players++ {
		for nights := 0; nights <= 12; nights++ {
			title := fallbackTitle(players, nights)
			if match := titleOutcomePattern.FindString(title); match != "" {
				t.Fatalf("fallback %q contains outcome token %q", title, match)
			}
			for _, name := range playerNames {
				if mentionsWord(title, name) {
					t.Fatalf("fallback %q names player %q", title, name)
				}
			}
			if reason := titleSpoiler(title, playerNames, titleLengthLimit); reason != "" {
				t.Fatalf("fallback %q failed the gate: %s", title, reason)
			}
		}
	}
	if got := fallbackTitle(8, 3); got != "Millers Hollow — eight voices, three nights" {
		t.Fatalf("fallback register changed: %q", got)
	}
}

// titleClient answers the naming prompt and records the temperature and prompt it was
// handed, so the runner's routing and gating can be observed.
type titleClient struct {
	temperatures []float64
	prompts      []string
	response     string
	err          error
}

func (c *titleClient) CompleteJSON(ctx context.Context, messages []model.Message) (string, error) {
	return c.CompleteJSONWithTemperature(ctx, messages, 0)
}

func (c *titleClient) CompleteJSONWithTemperature(_ context.Context, messages []model.Message, temperature float64) (string, error) {
	c.temperatures = append(c.temperatures, temperature)
	if len(messages) > 0 {
		c.prompts = append(c.prompts, messages[len(messages)-1].Content)
	}
	if c.err != nil {
		return "", c.err
	}
	return c.response, nil
}

func titleTestConfig(temperature float64, retries int) config.Config {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	return config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: retries, TitleTemperature: temperature},
	}
}

func TestGenerateTitleStoresGatedTitleAtItsOwnTemperature(t *testing.T) {
	client := &titleClient{response: `{"type":"title","title":"Ten Voices at Dusk"}`}
	runner, err := NewRunner(titleTestConfig(1.5, 2), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateTitle(context.Background())
	if runner.Title() != "Ten Voices at Dusk" {
		t.Fatalf("title = %q, want the parsed suggestion", runner.Title())
	}
	if len(client.temperatures) != 1 || client.temperatures[0] != 1.5 {
		t.Fatalf("title temperatures = %v, want [1.5]", client.temperatures)
	}
	if len(client.prompts) != 1 || !strings.Contains(client.prompts[0], "Title rules:") {
		t.Fatalf("naming prompt not sent as expected: %v", client.prompts)
	}
}

func TestGenerateTitleFallsBackWhenGatedTwice(t *testing.T) {
	client := &titleClient{response: `{"type":"title","title":"The Werewolves Win"}`}
	runner, err := NewRunner(titleTestConfig(1.2, 1), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateTitle(context.Background())
	want := fallbackTitle(len(runner.Game.Players()), runner.Game.Day())
	if runner.Title() != want {
		t.Fatalf("title = %q, want fallback %q", runner.Title(), want)
	}
	// MaxRetries=1 means the gate gets two looks before the fallback wins.
	if len(client.temperatures) != 2 {
		t.Fatalf("attempts = %d, want 2", len(client.temperatures))
	}
}

func TestGenerateTitleDisabledAndFailureUseFallback(t *testing.T) {
	disabled := &titleClient{response: `{"type":"title","title":"Ten Voices at Dusk"}`}
	runner, err := NewRunner(titleTestConfig(0, 2), disabled, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateTitle(context.Background())
	if len(disabled.temperatures) != 0 {
		t.Fatalf("expected no calls when disabled, got %d", len(disabled.temperatures))
	}
	if runner.Title() != fallbackTitle(len(runner.Game.Players()), runner.Game.Day()) {
		t.Fatalf("disabled title = %q, want fallback", runner.Title())
	}

	failing := &titleClient{err: errors.New("title service unavailable")}
	runner, err = NewRunner(titleTestConfig(1.2, 1), failing, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateTitle(context.Background())
	if runner.Title() != fallbackTitle(len(runner.Game.Players()), runner.Game.Day()) {
		t.Fatalf("failed title = %q, want fallback", runner.Title())
	}
}

// TestRunRecordsTitleInResult proves the whole path: a completed run carries a title into
// the sanitized result artifact.
func TestRunRecordsTitleInResult(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player", Personality: "Be concise."}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0, TitleTemperature: 0},
	}
	runner, err := NewRunner(cfg, &scriptedClient{}, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := NewResult(runner, cfg, 1, time.Now(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if result.Title == "" {
		t.Fatal("result carried no title")
	}
	if result.Title != fallbackTitle(len(players), runner.Game.Day()) {
		t.Fatalf("result title = %q, want the fallback", result.Title)
	}
}

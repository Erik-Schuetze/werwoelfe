package experiment

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/eschuetze/werwoelfe/internal/config"
	"github.com/eschuetze/werwoelfe/internal/game"
	"github.com/eschuetze/werwoelfe/internal/model"
)

type scriptedClient struct {
	calls    int
	requests [][]model.Message
}

func TestSystemInstructionUsesTruthfulInWorldFraming(t *testing.T) {
	instruction := systemInstruction(model.StyleClassic)
	for _, want := range []string{
		"assigned character",
		"fellow villagers",
		"do not claim that they are real people outside the game",
		"own voice",
		"Do not judge the quality or form",
	} {
		if !strings.Contains(instruction, want) {
			t.Fatalf("system instruction missing %q: %q", want, instruction)
		}
	}
	for _, forbidden := range []string{
		"filler",
		"unreadable",
		"public act",
		"action contract",
		"authorized event history",
	} {
		if strings.Contains(strings.ToLower(instruction), forbidden) {
			t.Fatalf("system instruction contains moderator jargon %q: %q", forbidden, instruction)
		}
	}
}

// TestSystemInstructionArmsShareFramingButDivergeOnWording proves the classic arm keeps its
// original ending and that the social arm differs both in the final judgement clause and in the
// register of the framing it shares (the social em-dash rewrite). The classic expectation is
// pinned verbatim; only the social expectation moves.
func TestSystemInstructionArmsShareFramingButDivergeOnWording(t *testing.T) {
	classic := systemInstruction(model.StyleClassic)
	social := systemInstruction(model.StyleSocial)
	if classic == social {
		t.Fatal("both arms share one system message")
	}
	if !strings.HasSuffix(classic, "Do not judge the quality or form of another person's message. Return only the requested JSON action.") {
		t.Fatalf("classic system instruction ending changed: %q", classic)
	}
	if !strings.HasSuffix(social, "Judge what a message is doing, what it is trying to make you believe, rather than the quality or form of how it is written. Return only the requested JSON action.") {
		t.Fatalf("social system instruction ending unexpected: %q", social)
	}
	// The arms still share the opening framing; they now diverge at the first social-only
	// register edit (the colon replacing the classic em dash after "recorded").
	prefix := 0
	for prefix < len(classic) && prefix < len(social) && classic[prefix] == social[prefix] {
		prefix++
	}
	if !strings.HasSuffix(classic[:prefix], "Never contradict anything the moderator recorded") {
		t.Fatalf("arms diverge before the shared opening; shared prefix ends %q", classic[:prefix])
	}
	// The social arm no longer renders the em-dashed phrasing the classic arm keeps.
	for _, classicDash := range []string{"recorded — ", "flavour light — ", "message is doing — "} {
		if strings.Contains(social, classicDash) {
			t.Fatalf("social system instruction still carries the classic em dash %q: %q", classicDash, social)
		}
	}
}

// temperatureClient answers every action call with an introduction and records the
// temperature it was handed. It implements TemperatureCompletionClient, so the runner
// must route player actions through CompleteJSONWithTemperature.
type temperatureClient struct {
	temperatures []float64
}

func (c *temperatureClient) CompleteJSON(ctx context.Context, messages []model.Message) (string, error) {
	// Fallback path: record a sentinel so a mistaken fallback is visible in assertions.
	return c.CompleteJSONWithTemperature(ctx, messages, -1)
}

func (c *temperatureClient) CompleteJSONWithTemperature(_ context.Context, _ []model.Message, temperature float64) (string, error) {
	c.temperatures = append(c.temperatures, temperature)
	return `{"type":"speak","message":"I am here."}`, nil
}

func TestRunnerResolvesPerPlayerTemperatureAndInheritsDefault(t *testing.T) {
	explicitZero := 0.0
	explicitWarm := 1.7
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	players[0].Temperature = &explicitZero // p1: explicitly deterministic
	players[1].Temperature = &explicitWarm // p2: explicitly warm
	// p3..p8 inherit the run default.
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0, Temperature: 1.0},
	}
	client := &temperatureClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if got := runner.playerTemperatures["p1"]; got != 0 {
		t.Fatalf("p1 temperature = %v, want explicit 0 (the *float64 trap)", got)
	}
	if got := runner.playerTemperatures["p2"]; got != explicitWarm {
		t.Fatalf("p2 temperature = %v, want %v", got, explicitWarm)
	}
	if got := runner.playerTemperatures["p3"]; got != 1.0 {
		t.Fatalf("p3 temperature = %v, want inherited run default 1.0", got)
	}
	if runner.DefaultTemperature != 1.0 {
		t.Fatalf("run default temperature = %v, want 1.0", runner.DefaultTemperature)
	}

	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"p1", "p2", "p3"} {
		if err := runner.requestAndApply(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	want := []float64{0, explicitWarm, 1.0}
	if len(client.temperatures) != len(want) {
		t.Fatalf("recorded temperatures = %v, want %v", client.temperatures, want)
	}
	for index, temperature := range want {
		if client.temperatures[index] != temperature {
			t.Fatalf("call %d temperature = %v, want %v", index, client.temperatures[index], temperature)
		}
	}
}

func TestRunnerUsesPromptStyleFromConfig(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	base := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0},
	}
	classicRunner, err := NewRunner(base, &scriptedClient{}, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if classicRunner.PromptStyle != model.StyleClassic {
		t.Fatalf("default prompt style = %q, want classic", classicRunner.PromptStyle)
	}
	base.Model.PromptStyle = config.PromptStyleSocial
	socialRunner, err := NewRunner(base, &scriptedClient{}, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if socialRunner.PromptStyle != model.StyleSocial {
		t.Fatalf("configured prompt style = %q, want social", socialRunner.PromptStyle)
	}
	base.Model.PromptStyle = "radical"
	if _, err := NewRunner(base, &scriptedClient{}, rand.New(rand.NewPCG(7, 8))); err == nil {
		t.Fatal("an unknown prompt style was accepted by NewRunner")
	}
}

// promptPlayerID reads the speaker's id out of the "<Name> (player <id>)" anchor.
func promptPlayerID(prompt string) string {
	const marker = "(player "
	start := strings.Index(prompt, marker)
	if start < 0 {
		return ""
	}
	rest := prompt[start+len(marker):]
	end := strings.Index(rest, ")")
	if end < 0 {
		return ""
	}
	return rest[:end]
}

func (c *scriptedClient) CompleteJSON(_ context.Context, messages []model.Message) (string, error) {
	c.calls++
	c.requests = append(c.requests, append([]model.Message(nil), messages...))
	if len(messages) == 0 {
		return "", fmt.Errorf("completion messages are empty")
	}
	prompt := messages[len(messages)-1].Content
	rosterJSON := promptValue(prompt, "People in the village: ", "\nLasting facts your character knows:")
	var roster []struct {
		ID    string `json:"id"`
		Alive bool   `json:"alive"`
	}
	if err := json.Unmarshal([]byte(rosterJSON), &roster); err != nil {
		return "", fmt.Errorf("parse roster from prompt: %w", err)
	}
	firstLiving := ""
	for _, player := range roster {
		if player.Alive {
			firstLiving = player.ID
			break
		}
	}
	switch {
	case strings.Contains(prompt, "introducing themselves before choosing a Sheriff"):
		return `{"type":"speak","message":"I am Player and I will consider running for Sheriff.","thought":"I want the badge but will not say so outright."}`, nil
	case strings.Contains(prompt, "private pack meeting"):
		return `{"type":"pass"}`, nil
	case strings.Contains(prompt, `{"action":"speak","message":"..."} or {"action":"pass"}`):
		speaker := promptPlayerID(prompt)
		for _, player := range roster {
			if !player.Alive || player.ID == speaker {
				continue
			}
			if c.calls%2 == 0 {
				return fmt.Sprintf(`{"type":"agree","target":%q,"message":"Agreed, and I will hold that line.","thought":"Backing the case already on the table."}`, player.ID), nil
			}
			return `{"type":"pass","thought":"Nothing new to add yet."}`, nil
		}
		return `{"type":"pass"}`, nil
	case strings.Contains(prompt, "make a final statement before the vote"):
		return `{"type":"speak","message":"I have no additional evidence."}`, nil
	case strings.Contains(prompt, `{"action":"declare","target":"living-player-id","message":"..."}`):
		speaker := promptPlayerID(prompt)
		for _, player := range roster {
			if !player.Alive || player.ID == speaker {
				continue
			}
			return fmt.Sprintf(`{"type":"declare","target":%q,"message":"Their story keeps changing"}`, player.ID), nil
		}
		return `{"type":"speak","message":"I have nothing else to add"}`, nil
	case strings.Contains(prompt, `{"action":"vote","target":"living-player-id"}`):
		return fmt.Sprintf(`{"type":"vote","target":%q}`, firstLiving), nil
	case strings.Contains(prompt, `{"action":"appoint_sheriff"`):
		return fmt.Sprintf(`{"type":"appoint_sheriff","target":%q,"message":"I pass the sash to %s."}`, firstLiving, firstLiving), nil
	case strings.Contains(prompt, `{"action":"investigate","target":"living-player-id"}`):
		return fmt.Sprintf(`{"type":"investigate","target":%q}`, firstLiving), nil
	case strings.Contains(prompt, `{"action":"eat","target":"living-non-werewolf-player-id"}`):
		wolves := strings.Split(strings.TrimSuffix(promptValue(prompt, "Your living packmates are: ", "."), "."), ", ")
		for _, player := range roster {
			if player.Alive && !contains(wolves, player.ID) {
				return fmt.Sprintf(`{"type":"eat","target":%q}`, player.ID), nil
			}
		}
	}
	return "", fmt.Errorf("unexpected action prompt: %q", prompt)
}

func TestRunnerCompletesGameWithStructuredMockActions(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{
			ID: "p" + string(rune('1'+index)), Name: "Player", Personality: "Be concise.",
		}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0},
	}
	client := &scriptedClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if runner.Game.Winner() == "" || client.calls == 0 {
		t.Fatalf("winner = %q, calls = %d", runner.Game.Winner(), client.calls)
	}
	positions := make(map[string]int)
	for index, event := range runner.Game.HistoryFor("") {
		switch event.Kind {
		case "introductions_completed", "sheriff_elected", "night_started", "dawn_started", "discussion_started", "exile_vote_started":
			if _, found := positions[event.Kind]; !found {
				positions[event.Kind] = index
			}
		}
	}
	for _, kind := range []string{"introductions_completed", "sheriff_elected", "night_started", "dawn_started", "discussion_started", "exile_vote_started"} {
		if _, found := positions[kind]; !found {
			t.Fatalf("missing %q event", kind)
		}
	}
	agreements := 0
	for _, event := range runner.Game.HistoryFor("") {
		if event.Kind == "town_hall_agreement" {
			agreements++
		}
	}
	if agreements == 0 {
		t.Fatal("a completed game recorded no agreement events")
	}
	if !(positions["introductions_completed"] < positions["sheriff_elected"] &&
		positions["sheriff_elected"] < positions["night_started"] &&
		positions["night_started"] < positions["dawn_started"] &&
		positions["dawn_started"] < positions["discussion_started"] &&
		positions["discussion_started"] < positions["exile_vote_started"]) {
		t.Fatalf("unexpected opening event order: %#v", positions)
	}
}

// TestSocialArmCompletesGameWithDeclarations runs the social arm end to end, proving the
// structured declaration flows through the runner and replaces the old required final speech.
func TestSocialArmCompletesGameWithDeclarations(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{
			ID: "p" + string(rune('1'+index)), Name: "Player", Personality: "Be concise.",
		}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0, PromptStyle: config.PromptStyleSocial},
	}
	client := &scriptedClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if runner.Game.Winner() == "" {
		t.Fatal("the social run did not reach a winner")
	}
	declarations := 0
	for _, event := range runner.Game.HistoryFor("") {
		if event.Kind != "final_declaration" {
			continue
		}
		declarations++
		if !strings.Contains(event.Message, " will vote for ") && !strings.Contains(event.Message, " declares: ") {
			t.Fatalf("unexpected declaration message: %q", event.Message)
		}
	}
	if declarations == 0 {
		t.Fatal("the social arm recorded no final declarations")
	}
}

func TestRunnerRecordsThoughtsPrivatelyAndNeverPromptsThem(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{
			ID: "p" + string(rune('1'+index)), Name: "Player", Personality: "Be concise.",
		}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0},
	}
	client := &scriptedClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	var events []game.Event
	runner.Game.SetEventObserver(func(event game.Event) { events = append(events, event) })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}

	thoughts := 0
	for _, event := range events {
		if event.Kind != "player_thought" {
			continue
		}
		thoughts++
		if event.Visibility != game.Private || len(event.Recipients) != 1 {
			t.Fatalf("thought event = %#v, want exactly one private recipient", event)
		}
	}
	// The scripted client attaches a thought to every introduction and every discussion
	// pass, so a completed game records at least one per player.
	if thoughts < len(players) {
		t.Fatalf("thought events = %d, want at least one per player (%d)", thoughts, len(players))
	}
	for _, event := range runner.Game.HistoryFor("") {
		if event.Kind == "player_thought" {
			t.Fatalf("thought leaked into public history: %#v", event)
		}
	}
	for _, request := range client.requests {
		for _, message := range request {
			if strings.Contains(message.Content, "I want the badge") || strings.Contains(message.Content, "Nothing new to add yet") {
				t.Fatalf("a private thought was fed back into a prompt: %q", message.Content)
			}
		}
	}
}

func TestRunnerUsesFreshRoleScopedSnapshots(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{
			ID: "p" + string(rune('1'+index)), Name: "Player", Personality: "Be concise.",
		}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0},
	}
	client := &scriptedClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	requestsByPlayer := make(map[string][][]model.Message)
	for _, request := range client.requests {
		playerID := playerIDForPrompt(request[len(request)-1].Content)
		if playerID == "" {
			t.Fatalf("cannot identify player from request: %#v", request)
		}
		requestsByPlayer[playerID] = append(requestsByPlayer[playerID], request)
		if len(request) != 2 || request[0].Role != "system" || request[1].Role != "user" {
			t.Fatalf("request for %q = %#v, want fresh system and current prompt", playerID, request)
		}
		if !strings.HasPrefix(request[1].Content, "You are Player (player "+playerID+").") {
			t.Fatalf("player %q received another player's prompt: %q", playerID, request[1].Content)
		}
	}
	for _, player := range players {
		requests := requestsByPlayer[player.ID]
		if len(requests) < 2 {
			t.Fatalf("player %q had %d requests, want at least 2", player.ID, len(requests))
		}
		for _, request := range requests {
			if len(request) != 2 || request[0].Role != "system" || request[1].Role != "user" {
				t.Fatalf("request for %q retained prior conversation: %#v", player.ID, request)
			}
		}
	}
}

func TestRunnerRetriesDoNotRetainRejectedResponses(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 1},
	}
	client := &retryClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	if err := runner.requestAndApply(context.Background(), "p1"); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(client.requests))
	}
	if len(client.requests[0]) != 2 {
		t.Fatalf("initial request = %#v, want system and current prompt", client.requests[0])
	}
	retry := client.requests[1]
	if len(retry) != 3 || retry[2].Role != "user" {
		t.Fatalf("retry request = %#v, want corrective user message", retry)
	}
	for _, want := range []string{"corrected JSON action", "source of truth", "response instructions"} {
		if !strings.Contains(retry[2].Content, want) {
			t.Fatalf("retry correction missing %q: %q", want, retry[2].Content)
		}
	}
}

func TestRunnerTruncatesOverlongSpeechWithoutRetrying(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 2},
	}
	client := &overlongSpeechClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	if err := runner.requestAndApply(context.Background(), "p1"); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(client.requests))
	}
	if runner.Game.CurrentSpeaker() != "p2" {
		t.Fatalf("current speaker = %q, want p2", runner.Game.CurrentSpeaker())
	}
	events := runner.Game.HistoryFor("")
	last := events[len(events)-1]
	if last.Kind != "player_introduced" || !strings.HasSuffix(last.Message, " [Time is up.]") {
		t.Fatalf("last event = %#v, want truncated introduction", last)
	}
}

func TestRunnerCorrectsInvalidMealTargetWithoutPersistingIt(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 1},
	}
	client := &invalidMealRetryClient{}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Game.StartNight(); err != nil {
		t.Fatal(err)
	}
	seer := runner.playerWithRole(game.Seer)
	if err := runner.Game.Apply(seer, game.Action{Type: "investigate", Target: runner.playersWithRole(game.Werewolf)[0]}); err != nil {
		t.Fatal(err)
	}
	for runner.Game.Phase() == game.WerewolfPlanning {
		if err := runner.Game.Apply(runner.Game.CurrentSpeaker(), game.Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	wolf := runner.playersWithRole(game.Werewolf)[0]
	client.wolfID = wolf
	for _, player := range runner.Game.LivingPlayers() {
		role, _ := runner.Game.RoleFor(player.ID)
		if role != game.Werewolf {
			client.validTarget = player.ID
			break
		}
	}
	if err := runner.requestAndApply(context.Background(), wolf); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(client.requests))
	}
	retry := client.requests[1]
	if len(retry) != 3 || !strings.Contains(retry[2].Content, `invalid meal target "`+wolf+`"`) || !strings.Contains(retry[2].Content, "source of truth") {
		t.Fatalf("retry = %#v, want corrective message with meal error and authority", retry)
	}
}

type invalidMealRetryClient struct {
	requests    [][]model.Message
	wolfID      string
	validTarget string
}

func (c *invalidMealRetryClient) CompleteJSON(_ context.Context, messages []model.Message) (string, error) {
	c.requests = append(c.requests, append([]model.Message(nil), messages...))
	if len(c.requests) == 1 {
		return fmt.Sprintf(`{"type":"eat","target":%q}`, c.wolfID), nil
	}
	return fmt.Sprintf(`{"type":"eat","target":%q}`, c.validTarget), nil
}

func messageContents(messages []model.Message) []string {
	contents := make([]string, len(messages))
	for index, message := range messages {
		contents[index] = message.Content
	}
	return contents
}

type retryClient struct {
	requests [][]model.Message
}

type overlongSpeechClient struct {
	requests [][]model.Message
}

func (c *overlongSpeechClient) CompleteJSON(_ context.Context, messages []model.Message) (string, error) {
	c.requests = append(c.requests, append([]model.Message(nil), messages...))
	return `{"type":"speak","message":"` + strings.Repeat("x", 501) + `"}`, nil
}

func (c *retryClient) CompleteJSON(_ context.Context, messages []model.Message) (string, error) {
	c.requests = append(c.requests, append([]model.Message(nil), messages...))
	if len(c.requests) == 1 {
		return `{"type":"unknown"}`, nil
	}
	return `{"type":"speak","message":"I am p1 and will consider running for Sheriff."}`, nil
}

func playerIDForPrompt(prompt string) string {
	const marker = "(player "
	start := strings.Index(prompt, marker)
	if start < 0 {
		return ""
	}
	playerID, _, found := strings.Cut(prompt[start+len(marker):], ")")
	if !found {
		return ""
	}
	return playerID
}

func TestResultContainsOnlyPublicHistory(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{BaseURL: "https://api.deepseek.com", Name: "deepseek-flash", Temperature: 1.3},
	}
	runner, err := NewRunner(cfg, &scriptedClient{}, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	startedAt := time.Date(2026, time.October, 11, 10, 0, 0, 0, time.UTC)
	result, err := NewResult(runner, cfg, 42, startedAt, startedAt.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if result.Seed != 42 || result.Winner == "" || len(result.Players) != len(players) {
		t.Fatalf("unexpected result: %#v", result)
	}
	for _, event := range result.PublicEventHistory {
		if event.Visibility != game.Public {
			t.Fatalf("private event included in result: %#v", event)
		}
	}

	path := filepath.Join(t.TempDir(), "result.json")
	if err := WriteResult(path, result); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "investigation_result") || strings.Contains(string(data), "meal_chosen") {
		t.Fatalf("result contains private events: %s", data)
	}
	var decoded Result
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Seed != result.Seed || decoded.Winner != result.Winner || decoded.Model.Temperature != 1.3 {
		t.Fatalf("decoded result = %#v, want %#v", decoded, result)
	}
}

func promptValue(prompt, before, after string) string {
	start := strings.Index(prompt, before)
	if start < 0 {
		return ""
	}
	start += len(before)
	end := strings.Index(prompt[start:], after)
	if end < 0 {
		return ""
	}
	return prompt[start : start+end]
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func testIDs() []string {
	ids := make([]string, 0, 8)
	for index := 1; index <= 8; index++ {
		ids = append(ids, fmt.Sprintf("p%d", index))
	}
	return ids
}

// castResponse builds a batch character response for the given ids.
func castResponse(ids ...string) string {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, fmt.Sprintf(`{"id":%q,"message":"Voice %s: speaks plainly and decides slowly."}`, id, id))
	}
	return `{"type":"characters","characters":[` + strings.Join(parts, ",") + `]}`
}

// characterClient answers the batch character prompt and the introduction prompt, recording
// the temperature and prompt for every call. A custom response overrides the default cast.
type characterClient struct {
	temperatures []float64
	requests     []string
	response     string
}

func (c *characterClient) CompleteJSON(ctx context.Context, messages []model.Message) (string, error) {
	return c.CompleteJSONWithTemperature(ctx, messages, 0)
}

func (c *characterClient) CompleteJSONWithTemperature(_ context.Context, messages []model.Message, temperature float64) (string, error) {
	prompt := ""
	if len(messages) > 0 {
		prompt = messages[len(messages)-1].Content
	}
	c.requests = append(c.requests, prompt)
	c.temperatures = append(c.temperatures, temperature)
	switch {
	case strings.Contains(prompt, "The players in this village are:"):
		if c.response != "" {
			return c.response, nil
		}
		return castResponse(testIDs()...), nil
	case strings.Contains(prompt, "introducing themselves before choosing a Sheriff"):
		return `{"type":"speak","message":"I am here."}`, nil
	}
	return "", fmt.Errorf("unexpected prompt: %q", prompt)
}

type alwaysFailClient struct{}

func (c *alwaysFailClient) CompleteJSON(context.Context, []model.Message) (string, error) {
	return "", fmt.Errorf("character service unavailable")
}

func characterTestConfig(temperature float64) config.Config {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player", Personality: "Be concise."}
	}
	return config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 0, CharacterTemperature: temperature},
	}
}

func TestCharacterGenerationStoresPrivatelyAndInjects(t *testing.T) {
	client := &characterClient{}
	runner, err := NewRunner(characterTestConfig(1.5), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateCast(context.Background())

	const want = "Voice p1: speaks plainly and decides slowly."
	if got := runner.characters["p1"]; got != want {
		t.Fatalf("character = %q, want %q", got, want)
	}
	if len(runner.characters) != 8 {
		t.Fatalf("characters = %d, want 8", len(runner.characters))
	}
	if len(client.temperatures) == 0 || client.temperatures[0] != 1.5 {
		t.Fatalf("character temperatures = %v, want first 1.5", client.temperatures)
	}
	public := ""
	for _, event := range runner.Game.HistoryFor("") {
		public += event.Message + "\n"
	}
	if strings.Contains(public, "speaks plainly") {
		t.Fatal("character leaked into public history")
	}
	own := ""
	for _, event := range runner.Game.HistoryFor("p1") {
		own += event.Message + "\n"
	}
	if !strings.Contains(own, "speaks plainly") {
		t.Fatal("character not visible to its own player")
	}

	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	if err := runner.runCurrentSpeaker(context.Background()); err != nil {
		t.Fatal(err)
	}
	injected := false
	for _, request := range client.requests {
		if strings.Contains(request, "(player p1)") && strings.Contains(request, "Your character (light colour only): "+want) {
			injected = true
		}
	}
	if !injected {
		t.Fatal("character was not injected into the player's prompt")
	}
}

func TestCharacterGenerationPartialCastFallsBack(t *testing.T) {
	client := &characterClient{response: castResponse("p1", "p2", "p3")}
	runner, err := NewRunner(characterTestConfig(1.2), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateCast(context.Background())
	if len(runner.characters) != 3 {
		t.Fatalf("characters = %d, want 3", len(runner.characters))
	}
	if _, ok := runner.characters["p4"]; ok {
		t.Fatal("p4 should have fallen back to personality")
	}
}

func TestCharacterGenerationFailureFallsBack(t *testing.T) {
	runner, err := NewRunner(characterTestConfig(1.5), &alwaysFailClient{}, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	// Must not panic or abort when the cast call fails.
	runner.generateCast(context.Background())
	if len(runner.characters) != 0 {
		t.Fatalf("characters = %v, want none", runner.characters)
	}
	for _, event := range runner.Game.HistoryFor("") {
		if event.Kind == "character_defined" {
			t.Fatal("unexpected character event after a failed generation")
		}
	}
}

// TestCastFailureIsRecordedAndRunStillProceeds proves the silent cast fallback is no longer
// silent: a rejected cast response is written to the failure log, while the run goes on with the
// players falling back to their configured personality.
func TestCastFailureIsRecordedAndRunStillProceeds(t *testing.T) {
	const badCast = `{"type":"characters","characters":[{"id":"ghost","message":"who is this?"}]}`
	client := &characterClient{response: badCast}
	runner, err := NewRunner(characterTestConfig(1.2), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.MaxRetries = 1
	var buffer strings.Builder
	runner.ResponseLog = &ResponseLog{writer: &buffer}

	runner.generateCast(context.Background())
	if len(runner.characters) != 0 {
		t.Fatalf("characters = %v, want none after a rejected cast", runner.characters)
	}

	lines := strings.Split(strings.TrimSpace(buffer.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("recorded %d cast failures, want one per attempt (2): %s", len(lines), buffer.String())
	}
	for index, line := range lines {
		var record FailureRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode cast record %q: %v", line, err)
		}
		if record.Phase != castFailureStep || record.Player != "" {
			t.Fatalf("record = %#v, want the cast_generation step and no single player", record)
		}
		if record.Attempt != index+1 {
			t.Fatalf("record attempt = %d, want %d", record.Attempt, index+1)
		}
		if !strings.Contains(record.Error, `unknown character id "ghost"`) {
			t.Fatalf("record error = %q, want the cast parse fault", record.Error)
		}
		if record.Response != badCast {
			t.Fatalf("record response = %q, want the raw cast text %q", record.Response, badCast)
		}
	}

	// A failed cast must not abort the run: a turn still completes normally afterwards.
	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	if err := runner.runCurrentSpeaker(context.Background()); err != nil {
		t.Fatalf("the run could not proceed after a cast failure: %v", err)
	}
}

func TestCastTransportFailureIsRecorded(t *testing.T) {
	var buffer strings.Builder
	runner, err := NewRunner(characterTestConfig(1.5), &alwaysFailClient{}, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.ResponseLog = &ResponseLog{writer: &buffer}
	runner.generateCast(context.Background())

	lines := strings.Split(strings.TrimSpace(buffer.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("recorded %d cast failures, want 1: %s", len(lines), buffer.String())
	}
	var record FailureRecord
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatal(err)
	}
	if record.Phase != castFailureStep || record.Player != "" {
		t.Fatalf("record = %#v, want the cast_generation step and no single player", record)
	}
	if record.Response != "" {
		t.Fatalf("record response = %q, want empty when the call returned no text", record.Response)
	}
	if !strings.Contains(record.Error, "character service unavailable") {
		t.Fatalf("record error = %q, want the transport fault", record.Error)
	}
}

// TestPartialCastIsRecordedAndMissingPlayersKeepTheirPersonality proves a table mixing generated
// voices with console presets is recorded as a degradation, while the run proceeds and the missing
// players fall back to their configured personality.
func TestPartialCastIsRecordedAndMissingPlayersKeepTheirPersonality(t *testing.T) {
	const partial = `{"type":"characters","characters":[{"id":"p1","message":"Voice p1: speaks plainly and decides slowly."},{"id":"p2","message":"Voice p2: speaks plainly and decides slowly."},{"id":"p3","message":"Voice p3: speaks plainly and decides slowly."}]}`
	client := &characterClient{response: partial}
	runner, err := NewRunner(characterTestConfig(1.2), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	var buffer strings.Builder
	runner.ResponseLog = &ResponseLog{writer: &buffer}

	runner.generateCast(context.Background())

	// The three generated voices are kept.
	if len(runner.characters) != 3 {
		t.Fatalf("characters = %v, want the three returned voices", runner.characters)
	}
	// Exactly one record, naming who fell back to their preset.
	lines := strings.Split(strings.TrimSpace(buffer.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("recorded %d cast records, want 1: %s", len(lines), buffer.String())
	}
	var record FailureRecord
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatal(err)
	}
	if record.Phase != castFailureStep || record.Player != "" || record.Attempt != 1 {
		t.Fatalf("record = %#v, want the cast_generation step, no player and attempt 1", record)
	}
	const wantError = "partial cast: 3 of 8 voices returned (missing p4, p5, p6, p7, p8)"
	if record.Error != wantError {
		t.Fatalf("record error = %q, want %q", record.Error, wantError)
	}
	if record.Response != partial {
		t.Fatalf("record response = %q, want the raw cast text", record.Response)
	}

	// The run still proceeds.
	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	if err := runner.runCurrentSpeaker(context.Background()); err != nil {
		t.Fatalf("the run could not proceed after a partial cast: %v", err)
	}
	// A player the cast response omitted draws on their configured personality, not a manner.
	prompt, err := model.BuildActionPrompt(runner.Game, model.PlayerPrompt{
		ID: "p4", Name: "Player", Personality: "Be concise.", Character: runner.characters["p4"],
	}, runner.PromptStyle)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(prompt, "Your character (light colour only)") {
		t.Fatal("a player missing from the cast was given a generated character")
	}
	if !strings.Contains(prompt, "Be concise.") {
		t.Fatal("a player missing from the cast did not fall back to their configured personality")
	}
}

func TestCharacterGenerationDisabledSkipsCalls(t *testing.T) {
	client := &characterClient{}
	runner, err := NewRunner(characterTestConfig(0), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateCast(context.Background())
	if len(client.requests) != 0 {
		t.Fatalf("expected no model calls when disabled, got %d", len(client.requests))
	}
	if len(runner.characters) != 0 {
		t.Fatal("expected no characters when disabled")
	}
}

func TestCharacterPromptStaysDistinctAndRestrained(t *testing.T) {
	client := &characterClient{}
	runner, err := NewRunner(characterTestConfig(1.2), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateCast(context.Background())
	prompt := ""
	for _, request := range client.requests {
		if strings.Contains(request, "The players in this village are:") {
			prompt = request
		}
	}
	if prompt == "" {
		t.Fatal("no character request was captured")
	}
	for _, want := range []string{"distinct speaking voice", "no two sound alike", "at most 200 characters", "no tapping"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("character request missing %q: %s", want, prompt)
		}
	}
	for _, forbidden := range []string{"vivid", "mannerism", "voice, background", "one or two sentences"} {
		if strings.Contains(strings.ToLower(prompt), forbidden) {
			t.Fatalf("character request still invites flourish (%q): %s", forbidden, prompt)
		}
	}
	if strings.Contains(systemInstruction(model.StyleClassic), "use your character's own voice") {
		t.Fatal("system instruction still tells players to perform their character")
	}
}

func TestCharacterGenerationRejectsOverlongCharacter(t *testing.T) {
	client := &characterClient{
		response: fmt.Sprintf(`{"type":"characters","characters":[{"id":"p1","message":%q}]}`, strings.Repeat("flavourful backstory ", 20)),
	}
	runner, err := NewRunner(characterTestConfig(1.2), client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	runner.generateCast(context.Background())
	if len(runner.characters) != 0 {
		t.Fatalf("over-long character was stored: %v", runner.characters)
	}
	if len(client.requests) == 0 {
		t.Fatal("character prompt was never attempted")
	}
	for _, event := range runner.Game.HistoryFor("p1") {
		if event.Kind == "character_defined" {
			t.Fatal("over-long character was recorded")
		}
	}
}

// malformedActionClient answers every action call with the same unparseable text, so
// requestAndApply exhausts its retries exactly as a real parse failure would.
type malformedActionClient struct {
	raw   string
	calls int
}

func (c *malformedActionClient) CompleteJSON(context.Context, []model.Message) (string, error) {
	c.calls++
	return c.raw, nil
}

// TestRunnerPersistsRawResponseOnParseFailure proves that a run which dies because the model
// would not emit acceptable JSON still leaves the raw response behind, next to the event stream
// and out of the public result, so the failure can be explained afterwards.
func TestRunnerPersistsRawResponseOnParseFailure(t *testing.T) {
	players := make([]config.Player, 8)
	for index := range players {
		players[index] = config.Player{ID: "p" + string(rune('1'+index)), Name: "Player"}
	}
	cfg := config.Config{
		Players: players,
		Roles: []game.Role{
			game.Werewolf, game.Werewolf, game.Seer,
			game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
		},
		Model: config.Model{MaxRetries: 1},
	}
	const malformed = `{"type":"speak","message":"oops`
	client := &malformedActionClient{raw: malformed}
	runner, err := NewRunner(cfg, client, rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	log := NewResponseLog(filepath.Join(dir, "events.ndjson"))
	defer func() { _ = log.Close() }()
	runner.ResponseLog = log

	if err := runner.Game.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	err = runner.requestAndApply(context.Background(), "p1")
	// The run still fails, with the same error it always produced.
	if err == nil {
		t.Fatal("run did not fail after the retry budget was exhausted")
	}
	if !strings.Contains(err.Error(), `player "p1" failed after 2 attempts`) || !strings.Contains(err.Error(), "parse action JSON") {
		t.Fatalf("failure error = %v, want the unchanged player/parse fault", err)
	}
	if client.calls != 2 {
		t.Fatalf("calls = %d, want MaxRetries+1 = 2", client.calls)
	}

	// It lands beside the event stream, never as the event stream itself.
	if _, statErr := os.Stat(filepath.Join(dir, "events.ndjson")); !os.IsNotExist(statErr) {
		t.Fatal("the diagnostics wrote to the event stream path")
	}
	data, readErr := os.ReadFile(filepath.Join(dir, failureLogName))
	if readErr != nil {
		t.Fatalf("read the failure log: %v", readErr)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("recorded %d failures, want one per attempt (2): %s", len(lines), data)
	}
	for index, line := range lines {
		var record FailureRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode failure record %q: %v", line, err)
		}
		if record.Phase != "introductions" || record.Player != "p1" {
			t.Fatalf("record = %#v, want the introductions phase and player p1", record)
		}
		if record.Attempt != index+1 {
			t.Fatalf("record attempt = %d, want %d", record.Attempt, index+1)
		}
		if !strings.Contains(record.Error, "parse action JSON") {
			t.Fatalf("record error = %q, want the parse fault", record.Error)
		}
		if record.Response != malformed {
			t.Fatalf("record response = %q, want the raw text %q", record.Response, malformed)
		}
	}
}

func TestResponseLogBoundsRecordsAndFallsBackToStderr(t *testing.T) {
	// Without an event path there is nowhere beside it to write, so the log falls back to stderr.
	if log := NewResponseLog(""); log.writer != os.Stderr {
		t.Fatal("an empty event path did not fall back to stderr")
	}
	// A runaway response is clipped so one record cannot bloat the file.
	var buffer strings.Builder
	log := &ResponseLog{writer: &buffer}
	log.Record(FailureRecord{
		Phase:    "discussion",
		Player:   "p1",
		Attempt:  1,
		Error:    strings.Repeat("e", failureErrorLimit+10),
		Response: strings.Repeat("x", failureResponseLimit+50),
	})
	var record FailureRecord
	if err := json.Unmarshal([]byte(strings.TrimSpace(buffer.String())), &record); err != nil {
		t.Fatal(err)
	}
	if got := len([]rune(record.Response)); got != failureResponseLimit {
		t.Fatalf("response length = %d, want it clipped to %d", got, failureResponseLimit)
	}
	if got := len([]rune(record.Error)); got != failureErrorLimit {
		t.Fatalf("error length = %d, want it clipped to %d", got, failureErrorLimit)
	}
	// A nil log is a no-op, so a test that does not configure one never panics.
	var nilLog *ResponseLog
	nilLog.Record(FailureRecord{Error: "ignored"})
}

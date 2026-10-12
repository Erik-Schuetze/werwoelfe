package model

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/eschuetze/werwoelfe/internal/game"
)

func TestParseActionToleratesUnknownFieldsButRejectsMalformations(t *testing.T) {
	// A reasoning model adding a field it was never asked for must not kill an otherwise
	// valid action.
	action, err := ParseAction(`{"type":"vote","target":"p1","extra":true,"confidence":0.9}`)
	if err != nil {
		t.Fatalf("an extra field rejected a valid action: %v", err)
	}
	if action.Type != "vote" || action.Target != "p1" {
		t.Fatalf("action = %#v, want a vote for p1", action)
	}
	// Trailing and multiple JSON values are genuine malformations and still fail.
	if _, err := ParseAction(`{"type":"pass"} {"type":"pass"}`); err == nil {
		t.Fatal("trailing JSON value was accepted")
	}
	trimmed, err := ParseAction(`{"type":"speak","message":" hello "}`)
	if err != nil || trimmed.Message != "hello" {
		t.Fatalf("action = %#v, error = %v", trimmed, err)
	}
}

func TestParseActionPrefersActionAndFallsBackToType(t *testing.T) {
	// {"action":"speak","message":"…"} is the requested shape and must yield a speak.
	aliased, err := ParseAction(`{"action":"speak","message":"x"}`)
	if err != nil {
		t.Fatalf("action discriminator rejected: %v", err)
	}
	if aliased.Type != "speak" || aliased.Message != "x" {
		t.Fatalf("action = %#v, want a speak with message x", aliased)
	}
	// The old "type" key is still accepted as a fallback for an in-flight or replayed caller.
	legacy, err := ParseAction(`{"type":"vote","target":"p1"}`)
	if err != nil {
		t.Fatalf("type fallback rejected: %v", err)
	}
	if legacy.Type != "vote" || legacy.Target != "p1" {
		t.Fatalf("type-fallback action = %#v, want a vote for p1", legacy)
	}
	// When both keys appear, "action" wins so a stale or leaked "type" cannot override it.
	both, err := ParseAction(`{"type":"vote","action":"speak","target":"p2"}`)
	if err != nil {
		t.Fatalf("both keys rejected: %v", err)
	}
	if both.Type != "speak" {
		t.Fatalf("type = %q, want \"speak\" to win over the type fallback", both.Type)
	}
	if _, err := ParseAction(`{"target":"p1"}`); err == nil {
		t.Fatal("an action with neither action nor type was accepted")
	}
}

// TestParseActionTreatsLeakedJSONModeValueAsMissing proves a response whose discriminator is
// the request's own JSON-mode value is reported as *no action given* — a parse failure the
// corrective retry can name — rather than as an action named "json_object" that the phase
// would then reject as an illegal action. The rename to "action" removes the collision; this
// is the belt-and-braces guard against the request shape changing again.
func TestParseActionTreatsLeakedJSONModeValueAsMissing(t *testing.T) {
	for _, raw := range []string{
		`{"type":"json_object","message":"hi"}`,
		`{"action":"json_object"}`,
		`{"action":"json"}`,
	} {
		if _, err := ParseAction(raw); err == nil || err.Error() != "action type is required" {
			t.Fatalf("leaked JSON-mode discriminator %s: err = %v, want the missing-action error", raw, err)
		}
	}
	// A real action alongside the leak still resolves, because "action" is read first.
	if action, err := ParseAction(`{"type":"json_object","action":"speak","message":"hi"}`); err != nil || action.Type != "speak" {
		t.Fatalf("action alongside a leaked mode value = %#v, err = %v", action, err)
	}
	// The requested "action" key parses as a speak...
	action, err := ParseAction(`{"action":"speak","message":"hi"}`)
	if err != nil || action.Type != "speak" || action.Message != "hi" {
		t.Fatalf("action-keyed speak = %#v, err = %v", action, err)
	}
	// ...and the old "type" key still parses as a speak too.
	legacy, err := ParseAction(`{"type":"speak","message":"hi"}`)
	if err != nil || legacy.Type != "speak" || legacy.Message != "hi" {
		t.Fatalf("type-keyed speak = %#v, err = %v", legacy, err)
	}
}

func TestParseActionAdoptsReasoningAliasAsThought(t *testing.T) {
	// A response carrying only reasoning_note must surface it as the thought.
	note, err := ParseAction(`{"type":"pass","reasoning_note":"  hold my read  "}`)
	if err != nil {
		t.Fatalf("reasoning_note rejected: %v", err)
	}
	if note.Thought != "hold my read" {
		t.Fatalf("thought = %q, want the trimmed reasoning_note", note.Thought)
	}
	// The aliases are tried in order: reasoning before analysis.
	ordered, err := ParseAction(`{"type":"pass","analysis":"second","reasoning":"first"}`)
	if err != nil {
		t.Fatal(err)
	}
	if ordered.Thought != "first" {
		t.Fatalf("thought = %q, want the first-present reasoning alias", ordered.Thought)
	}
	afterNote, err := ParseAction(`{"type":"pass","analysis":"b","reasoning_note":"c"}`)
	if err != nil {
		t.Fatal(err)
	}
	if afterNote.Thought != "c" {
		t.Fatalf("thought = %q, want reasoning_note to precede analysis", afterNote.Thought)
	}
	// An explicit thought is never overridden by an alias.
	explicit, err := ParseAction(`{"type":"pass","thought":"t","reasoning":"r"}`)
	if err != nil {
		t.Fatal(err)
	}
	if explicit.Thought != "t" {
		t.Fatalf("thought = %q, want the explicit thought to win", explicit.Thought)
	}
}

func TestParseActionRejectsMalformedJSON(t *testing.T) {
	cases := map[string]string{
		"truncated":        `{"type":"speak","message":"hi"`,
		"trailing garbage": `{"type":"pass"} nonsense`,
		"two objects":      `{"type":"pass"} {"type":"pass"}`,
		"empty":            ``,
	}
	for name, raw := range cases {
		if _, err := ParseAction(raw); err == nil {
			t.Fatalf("%s JSON was accepted: %q", name, raw)
		}
	}
}

// TestUnknownActionTypeStillFailsValidation proves tolerating extra fields and the "action"
// alias cannot smuggle a type the current phase forbids past the game's own validation.
func TestUnknownActionTypeStillFailsValidation(t *testing.T) {
	players := make([]game.Player, 8)
	for index := range players {
		players[index] = game.Player{ID: fmt.Sprintf("p%d", index+1), Name: "Player"}
	}
	g, err := game.New(players, game.RecommendedRoles(len(players)), rand.New(rand.NewPCG(7, 8)))
	if err != nil {
		t.Fatal(err)
	}
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	// Parses cleanly (extra fields tolerated, alias accepted) but the phase only allows speak.
	parsed, err := ParseAction(`{"type":"vote","target":"p2","reasoning":"skip ahead","extra":1}`)
	if err != nil {
		t.Fatalf("tolerant parse failed: %v", err)
	}
	if err := g.Apply(g.CurrentSpeaker(), parsed); err == nil {
		t.Fatal("an introduction-phase vote slipped past validation")
	}
	// A type the game has never heard of is likewise refused.
	unknown, err := ParseAction(`{"action":"teleport"}`)
	if err != nil {
		t.Fatalf("a non-empty type should parse: %v", err)
	}
	if err := g.Apply(g.CurrentSpeaker(), unknown); err == nil {
		t.Fatal("an unknown action type was accepted")
	}
}

func TestDeepSeekClientSendsJSONModeAndReturnsContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization = %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), `"response_format":{"type":"json_object"}`) {
			t.Fatalf("request does not enable JSON mode: %s", body)
		}
		if !strings.Contains(string(body), `"thinking":{"type":"disabled"}`) {
			t.Fatalf("request does not disable thinking mode: %s", body)
		}
		if !strings.Contains(string(body), `"temperature":1.3`) {
			t.Fatalf("request does not set the configured temperature: %s", body)
		}
		var request chatRequest
		if err := json.Unmarshal(body, &request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		wantMessages := []Message{
			{Role: "system", Content: "system"},
			{Role: "user", Content: "first prompt"},
			{Role: "assistant", Content: `{"type":"pass"}`},
			{Role: "user", Content: "current prompt"},
		}
		if !reflect.DeepEqual(request.Messages, wantMessages) {
			t.Fatalf("messages = %#v, want %#v", request.Messages, wantMessages)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"{\"type\":\"pass\"}"}}]}`))
	}))
	defer server.Close()
	client, err := NewDeepSeek(server.URL, "test-key", "test-model", 1.3, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	content, err := client.CompleteJSON(context.Background(), []Message{
		{Role: "system", Content: "system"},
		{Role: "user", Content: "first prompt"},
		{Role: "assistant", Content: `{"type":"pass"}`},
		{Role: "user", Content: "current prompt"},
	})
	if err != nil || content != `{"type":"pass"}` {
		t.Fatalf("content = %q, error = %v", content, err)
	}
}

func TestPromptDoesNotExposeOtherRoles(t *testing.T) {
	players := []game.Player{
		{ID: "a", Name: "A"}, {ID: "b", Name: "B"}, {ID: "c", Name: "C"}, {ID: "d", Name: "D"},
		{ID: "e", Name: "E"}, {ID: "f", Name: "F"}, {ID: "g", Name: "G"}, {ID: "h", Name: "H"},
	}

	g, err := game.New(players, []game.Role{
		game.Werewolf, game.Werewolf, game.Seer, game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
	}, rand.New(rand.NewPCG(3, 4)))
	if err != nil {
		t.Fatal(err)
	}
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	var seer, wolf, villager string
	for _, player := range players {
		role, _ := g.RoleFor(player.ID)
		switch role {
		case game.Seer:
			seer = player.ID
		case game.Werewolf:
			wolf = player.ID
		case game.Villager:
			villager = player.ID
		}
	}
	if err := g.Apply(seer, game.Action{Type: "investigate", Target: wolf}); err != nil {
		t.Fatal(err)
	}
	prompt, err := BuildActionPrompt(g, PlayerPrompt{ID: villager}, StyleClassic)
	if err == nil || !strings.Contains(err.Error(), "cannot act") {
		t.Fatalf("non-acting player prompt error = %v", err)
	}
	if strings.Contains(prompt, "investigation_result") || strings.Contains(prompt, "is a werewolf") {
		t.Fatal("investigation leaked into villager prompt")
	}
}

func TestActionPromptUsesInWorldSpeechGuidance(t *testing.T) {
	g := testGameForPrompt(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	prompt, err := BuildActionPrompt(g, PlayerPrompt{ID: "a"}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"among fellow villagers in an ongoing game",
		"lying is legal and expected play",
		"People in the village:",
		"Lasting facts your character knows:",
		"Recent events your character knows:",
		"Always include a \"thought\" field",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q: %s", want, prompt)
		}
	}
	for _, want := range []string{
		"in your own voice",
		"at most 480 characters",
		`{"action":"agree","target":"living-player-id","message":"..."}`,
	} {
		if !strings.Contains(actionContract(contractGame(t, game.Discussion), StyleClassic), want) {
			t.Fatalf("discussion contract missing %q", want)
		}
	}
	if !strings.Contains(actionContract(contractGame(t, game.Discussion), StyleClassic), `{"action":"speak","message":"..."} or {"action":"pass"}`) {
		t.Fatalf("discussion contract lost the speak/pass literal the scripted client matches: %s", actionContract(contractGame(t, game.Discussion), StyleClassic))
	}
	for _, want := range []string{
		"introduce yourself by name",
		"intend to run for Sheriff",
		"bluffing are allowed",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("introduction prompt missing %q: %s", want, prompt)
		}
	}
	for _, forbidden := range []string{
		"filler",
		"public roster",
		"authorized event history",
		"action contract",
	} {
		if strings.Contains(strings.ToLower(prompt), forbidden) ||
			strings.Contains(strings.ToLower(actionContract(contractGame(t, game.Discussion), StyleClassic)), forbidden) ||
			strings.Contains(strings.ToLower(actionContract(contractGame(t, game.FinalStatements), StyleClassic)), forbidden) {
			t.Fatalf("speech guidance contains moderator jargon %q", forbidden)
		}
	}
}

func TestWerewolfPromptSharesPackPlansWithoutSeerResults(t *testing.T) {
	g := testGameForPrompt(t)
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	var seer, wolf, otherWolf string
	for _, player := range g.Players() {
		role, _ := g.RoleFor(player.ID)
		switch role {
		case game.Seer:
			seer = player.ID
		case game.Werewolf:
			if wolf == "" {
				wolf = player.ID
			} else {
				otherWolf = player.ID
			}
		}
	}
	if err := g.Apply(seer, game.Action{Type: "investigate", Target: otherWolf}); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(wolf, game.Action{Type: "plan", Message: "Keep pressure off each other tomorrow."}); err != nil {
		t.Fatal(err)
	}
	prompt, err := BuildActionPrompt(g, PlayerPrompt{ID: otherWolf}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Your living packmates are: " + wolf + ", " + otherWolf + ".",
		"Keep pressure off each other tomorrow.",
		`"action":"plan"`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("werewolf prompt missing %q: %s", want, prompt)
		}
	}
	if strings.Contains(prompt, "is a werewolf") {
		t.Fatalf("werewolf prompt leaked Seer result: %s", prompt)
	}
}

func TestActionPromptGuidesAgainstEchoingAfterTheTranscript(t *testing.T) {
	g := testGameForPrompt(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == game.Introductions {
		if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "speak", Message: "I am here."}); err != nil {
			t.Fatal(err)
		}
	}
	sheriff, seer, villager := "", "", ""
	for _, player := range g.LivingPlayers() {
		switch role, _ := g.RoleFor(player.ID); role {
		case game.Werewolf:
			if sheriff == "" {
				sheriff = player.ID
			}
		case game.Seer:
			seer = player.ID
		case game.Villager:
			if villager == "" {
				villager = player.ID
			}
		}
	}
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, game.Action{Type: "vote", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(seer, game.Action{Type: "investigate", Target: sheriff}); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == game.WerewolfPlanning {
		if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.Apply(sheriff, game.Action{Type: "eat", Target: villager}); err != nil {
		t.Fatal(err)
	}
	for _, player := range g.LivingPlayers() {
		if role, _ := g.RoleFor(player.ID); role == game.Werewolf && player.ID != sheriff {
			if err := g.Apply(player.ID, game.Action{Type: "eat", Target: villager}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
	prompt, err := BuildActionPrompt(g, PlayerPrompt{ID: g.CurrentSpeaker()}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	const echo = "do not make it again in your own words"
	const transcript = "Recent events your character knows:"
	echoAt, transcriptAt := strings.Index(prompt, echo), strings.Index(prompt, transcript)
	if echoAt < 0 {
		t.Fatalf("discussion prompt missing the anti-echo block: %s", prompt)
	}
	if transcriptAt < 0 || echoAt < transcriptAt {
		t.Fatalf("anti-echo block does not follow the transcript: %s", prompt)
	}
}

func TestParseActionTrimsThoughtAndKeepsUnknownFields(t *testing.T) {
	action, err := ParseAction(`{"type":"speak","message":"hi","thought":"  work it out  "}`)
	if err != nil {
		t.Fatal(err)
	}
	if action.Thought != "work it out" {
		t.Fatalf("thought = %q, want it trimmed", action.Thought)
	}
	// An unknown field alongside an explicit thought is now ignored, not fatal.
	withExtra, err := ParseAction(`{"type":"speak","message":"hi","thought":"t","reasoning":"ignored"}`)
	if err != nil {
		t.Fatalf("unknown field rejected a thought-bearing action: %v", err)
	}
	if withExtra.Thought != "t" {
		t.Fatalf("thought = %q, want the explicit thought kept", withExtra.Thought)
	}
}

func TestPromptHistorySkipsThoughtsAndCharacters(t *testing.T) {
	events := []game.Event{
		{Kind: "player_thought", Message: "Player: private"},
		{Kind: "character_defined", Message: "Player: a character"},
		{Kind: "town_hall_message", Message: "Player: hello"},
	}
	durable, recent := promptHistory(events)
	if len(durable) != 0 {
		t.Fatalf("durable events = %#v, want none", durable)
	}
	if len(recent) != 1 || recent[0].Kind != "town_hall_message" {
		t.Fatalf("recent events = %#v, want only the public message", recent)
	}
}

func TestPromptHistoryIsBounded(t *testing.T) {
	events := make([]game.Event, 0, recentEventLimit+1)
	for index := 0; index <= recentEventLimit; index++ {
		events = append(events, game.Event{Kind: "town_hall_message", Message: fmt.Sprintf("message %d", index)})
	}
	durable, recent := promptHistory(events)
	if len(durable) != 0 {
		t.Fatalf("durable events = %d, want 0", len(durable))
	}
	if len(recent) != recentEventLimit || recent[0].Message != "message 1" {
		t.Fatalf("recent events = %#v, want last %d", recent, recentEventLimit)
	}
}

func testGameForPrompt(t *testing.T) *game.Game {
	t.Helper()
	players := make([]game.Player, 8)
	for i := range players {
		players[i] = game.Player{ID: string(rune('a' + i)), Name: "Player"}
	}
	g, err := game.New(players, []game.Role{
		game.Werewolf, game.Werewolf, game.Seer, game.Villager, game.Villager, game.Villager, game.Villager, game.Villager,
	}, rand.New(rand.NewPCG(1, 2)))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestActionPromptAnchorsIdentityByNameAndID(t *testing.T) {
	g := testGameForPrompt(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	prompt, err := BuildActionPrompt(g, PlayerPrompt{ID: "a", Name: "Ada", Personality: "Be concise."}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(prompt, "You are Ada (player a).") {
		t.Fatalf("prompt missing name+id anchor: %s", prompt)
	}
	if !strings.Contains(prompt, "How this game works:") {
		t.Fatalf("prompt missing the rules digest: %s", prompt)
	}
}

func TestActionPromptIncludesCharacterWhenSet(t *testing.T) {
	g := testGameForPrompt(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	const character = "A retired lighthouse keeper who trusts nobody."
	withCharacter, err := BuildActionPrompt(g, PlayerPrompt{ID: "a", Name: "Ada", Character: character}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(withCharacter, "Your character (light colour only): "+character) {
		t.Fatalf("prompt missing character: %s", withCharacter)
	}
	if !strings.Contains(withCharacter, "colour how you phrase things in every message") {
		t.Fatalf("prompt does not ask the voice to persist: %s", withCharacter)
	}
	reminder := "Keep your own voice in this message too: " + character
	reminderAt, transcriptAt := strings.Index(withCharacter, reminder), strings.Index(withCharacter, "Recent events your character knows:")
	if reminderAt < 0 || transcriptAt < 0 || reminderAt < transcriptAt {
		t.Fatalf("the voice reminder does not follow the transcript: %s", withCharacter)
	}
	without, err := BuildActionPrompt(g, PlayerPrompt{ID: "a", Name: "Ada"}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(without, "Your character (light colour only):") {
		t.Fatalf("prompt should omit the character line when unset: %s", without)
	}
}

func TestWerewolfBriefAuthorisesBoldLiesAndVillagersAreNot(t *testing.T) {
	g := testGameForPrompt(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	var wolf, villager string
	for _, player := range g.Players() {
		switch role, _ := g.RoleFor(player.ID); role {
		case game.Werewolf:
			wolf = player.ID
		case game.Villager:
			villager = player.ID
		}
	}
	wolfPrompt, err := BuildActionPrompt(g, PlayerPrompt{ID: wolf, Name: "Wolf"}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"claim to be the Fortune Teller", "expected play, not cheating"} {
		if !strings.Contains(wolfPrompt, want) {
			t.Fatalf("werewolf brief missing %q: %s", want, wolfPrompt)
		}
	}
	villagerPrompt, err := BuildActionPrompt(g, PlayerPrompt{ID: villager, Name: "Villager"}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(villagerPrompt, "secretly a Werewolf") {
		t.Fatalf("villager prompt carries the werewolf brief: %s", villagerPrompt)
	}
}

func TestFinalStatementContractAsksForSomethingNew(t *testing.T) {
	contract := actionContract(contractGame(t, game.FinalStatements), StyleClassic)
	for _, want := range []string{"the one thing you have not yet said", "500 characters"} {
		if !strings.Contains(contract, want) {
			t.Fatalf("final statement contract missing %q: %s", want, contract)
		}
	}
}

func TestSheriffSuccessionContractFramesTrustChoice(t *testing.T) {
	contract := actionContract(contractGame(t, game.SheriffSuccession), StyleClassic)
	for _, want := range []string{"trust most", "next in turn", "appoint_sheriff"} {
		if !strings.Contains(contract, want) {
			t.Fatalf("succession contract missing %q: %s", want, contract)
		}
	}
}

func TestParseCharactersDropsEmptyAndOverlong(t *testing.T) {
	raw := `{"type":"characters","characters":[` +
		`{"id":"p1","message":"Speaks plainly."},` +
		`{"id":"p2","message":"   "},` +
		`{"id":"p3","message":"` + strings.Repeat("x", 200) + `"}]}`
	characters, err := ParseCharacters(raw, []string{"p1", "p2", "p3"}, 160)
	if err != nil {
		t.Fatal(err)
	}
	if len(characters) != 1 || characters["p1"] != "Speaks plainly." {
		t.Fatalf("characters = %#v", characters)
	}
}

func TestParseCharactersToleratesPartialBatch(t *testing.T) {
	characters, err := ParseCharacters(`{"type":"characters","characters":[{"id":"p2","message":"Dry and brief."}]}`, []string{"p1", "p2"}, 160)
	if err != nil {
		t.Fatal(err)
	}
	if len(characters) != 1 || characters["p2"] != "Dry and brief." {
		t.Fatalf("characters = %#v", characters)
	}
}

func TestParseCharactersRejectsMalformedBatches(t *testing.T) {
	cases := map[string]string{
		"unknown id":  `{"type":"characters","characters":[{"id":"px","message":"hi"}]}`,
		"wrong type":  `{"type":"character","characters":[{"id":"p1","message":"hi"}]}`,
		"empty batch": `{"type":"characters","characters":[]}`,
		"duplicate":   `{"type":"characters","characters":[{"id":"p1","message":"a"},{"id":"p1","message":"b"}]}`,
		"trailing":    `{"type":"characters","characters":[{"id":"p1","message":"a"}]} {}`,
	}
	for name, raw := range cases {
		if _, err := ParseCharacters(raw, []string{"p1"}, 160); err == nil {
			t.Fatalf("%s batch was accepted: %s", name, raw)
		}
	}
}

// discussionGameForPrompt drives testGameForPrompt through the opening day to the
// Discussion phase, so prompt assembly can be compared with the transcript present.
func discussionGameForPrompt(t *testing.T) *game.Game {
	t.Helper()
	g := testGameForPrompt(t)
	driveToDiscussion(t, g)
	return g
}

// driveToDiscussion advances an eight-player game from Setup to the first Discussion turn.
func driveToDiscussion(t *testing.T, g *game.Game) {
	t.Helper()
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == game.Introductions {
		if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "speak", Message: "I am here."}); err != nil {
			t.Fatal(err)
		}
	}
	sheriff, seer, villager := "", "", ""
	for _, player := range g.LivingPlayers() {
		switch role, _ := g.RoleFor(player.ID); role {
		case game.Werewolf:
			if sheriff == "" {
				sheriff = player.ID
			}
		case game.Seer:
			seer = player.ID
		case game.Villager:
			if villager == "" {
				villager = player.ID
			}
		}
	}
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, game.Action{Type: "vote", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(seer, game.Action{Type: "investigate", Target: sheriff}); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == game.WerewolfPlanning {
		if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.Apply(sheriff, game.Action{Type: "eat", Target: villager}); err != nil {
		t.Fatal(err)
	}
	for _, player := range g.LivingPlayers() {
		if role, _ := g.RoleFor(player.ID); role == game.Werewolf && player.ID != sheriff {
			if err := g.Apply(player.ID, game.Action{Type: "eat", Target: villager}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
}

// contractGame drives a fresh eight-player game to the named phase. actionContract reads the game
// for its social protocol line, so even a classic-branch assertion needs a game in that phase.
func contractGame(t *testing.T, phase game.Phase) *game.Game {
	t.Helper()
	g := testGameForPrompt(t)
	switch phase {
	case game.Discussion:
		driveToDiscussion(t, g)
	case game.FinalStatements:
		driveToDiscussion(t, g)
		for g.Phase() == game.Discussion {
			if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "pass"}); err != nil {
				t.Fatal(err)
			}
		}
	case game.WerewolfPlanning:
		if err := g.StartNight(); err != nil {
			t.Fatal(err)
		}
		seer, wolf := "", ""
		for _, player := range g.Players() {
			switch role, _ := g.RoleFor(player.ID); role {
			case game.Seer:
				seer = player.ID
			case game.Werewolf:
				if wolf == "" {
					wolf = player.ID
				}
			}
		}
		if err := g.Apply(seer, game.Action{Type: "investigate", Target: wolf}); err != nil {
			t.Fatal(err)
		}
	case game.SheriffSuccession:
		driveToSheriffSuccession(t, g)
	}
	if g.Phase() != phase {
		t.Fatalf("phase = %q, want %q", g.Phase(), phase)
	}
	return g
}

// driveToSheriffSuccession elects a villager as Sheriff and has the pack eat them overnight, which
// diverts the dawn into the succession phase without ending the game.
func driveToSheriffSuccession(t *testing.T, g *game.Game) {
	t.Helper()
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == game.Introductions {
		if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "speak", Message: "I am here."}); err != nil {
			t.Fatal(err)
		}
	}
	sheriff, seer, wolf := "", "", ""
	for _, player := range g.LivingPlayers() {
		switch role, _ := g.RoleFor(player.ID); role {
		case game.Villager:
			if sheriff == "" {
				sheriff = player.ID
			}
		case game.Seer:
			seer = player.ID
		case game.Werewolf:
			if wolf == "" {
				wolf = player.ID
			}
		}
	}
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, game.Action{Type: "vote", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(seer, game.Action{Type: "investigate", Target: wolf}); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == game.WerewolfPlanning {
		if err := g.Apply(g.CurrentSpeaker(), game.Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, player := range g.LivingPlayers() {
		if role, _ := g.RoleFor(player.ID); role == game.Werewolf {
			if err := g.Apply(player.ID, game.Action{Type: "eat", Target: sheriff}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
}

// TestSocialArmRewritesPromptsAndLeavesClassicPinned proves the two arms diverge and
// that the classic fragments are byte-identical to the pre-experiment wording. The
// classic literals below are copied verbatim from the control arm; if a future edit
// touches them, this test fails.
func TestSocialArmRewritesPromptsAndLeavesClassicPinned(t *testing.T) {
	const classicThought = `Always include a "thought" field: one or two private sentences of your own reasoning (at most 400 characters). It is never shown to any other player and is not a claim — use it to work out what you are doing, not to perform.`
	if got := thoughtGuidance(StyleClassic); got != classicThought {
		t.Fatalf("classic thought guidance changed:\n got: %q\nwant: %q", got, classicThought)
	}
	const classicAntiEcho = "\n\nBefore you answer, check what the village has already heard today. If a case has already been made against a player, do not make it again in your own words — either add a fact nobody has used yet, or agree with it in a few words instead. Your own wording still counts as repeating it, and bringing more than one new point wastes the turn. Address at most one player."
	if got := antiEchoGuidance(game.Discussion, "", StyleClassic); got != classicAntiEcho {
		t.Fatalf("classic anti-echo block changed:\n got: %q\nwant: %q", got, classicAntiEcho)
	}
	const classicDiscussion = `You may speak, agree, or stay silent. Reply with {"action":"speak","message":"..."} or {"action":"pass"}, or — when a case you accept is already on the table — {"action":"agree","target":"living-player-id","message":"..."} with at most a few words of your own. Agreeing is the right answer to a case that has already been made; restating it in your own words wastes the round. Silence is a normal move too: passing is not suspicious and is often stronger than padding. Speak only when you have one concrete thing that moves your own case: one concrete observation, question, or concern, in your own voice, in one or two short sentences (at most 480 characters). Do not narrate game mechanics, judge the wording of another person's message, or repeat a stock case against someone.`
	if got := actionContract(contractGame(t, game.Discussion), StyleClassic); got != classicDiscussion {
		t.Fatalf("classic discussion contract changed:\n got: %q\nwant: %q", got, classicDiscussion)
	}
	const classicFinal = `Each villager may make a final statement before the vote; this one is required. Reply with {"action":"speak","message":"..."}. Say the one thing you have not yet said. If you have nothing new, name the player you will vote for and the single reason for it, in one sentence, in your own voice, in at most 500 characters. Do not narrate game mechanics, judge the wording of another person's message, or repeat a stock case against someone.`
	if got := actionContract(contractGame(t, game.FinalStatements), StyleClassic); got != classicFinal {
		t.Fatalf("classic final statement contract changed:\n got: %q\nwant: %q", got, classicFinal)
	}

	// The social arm rewrites exactly those fragments...
	socialAntiEcho := antiEchoGuidance(game.Discussion, "", StyleSocial)
	for _, want := range []string{"press, escalate, reframe, or pivot", "change your mind out loud", "You may address more than one player"} {
		if !strings.Contains(socialAntiEcho, want) {
			t.Fatalf("social anti-echo block missing %q: %q", want, socialAntiEcho)
		}
	}
	for _, forbidden := range []string{"agree with it in a few words instead", "Address at most one player"} {
		if strings.Contains(socialAntiEcho, forbidden) {
			t.Fatalf("social anti-echo block kept the classic prohibition %q: %q", forbidden, socialAntiEcho)
		}
	}
	socialDiscussion := actionContract(contractGame(t, game.Discussion), StyleSocial)
	if strings.Contains(socialDiscussion, "Agreeing is the right answer") {
		t.Fatalf("social discussion contract kept the agree-or-pass rule: %q", socialDiscussion)
	}
	if strings.Contains(socialDiscussion, "judge the wording of another person's message") {
		t.Fatalf("social discussion contract kept the judgement prohibition: %q", socialDiscussion)
	}
	// ...while keeping the invariants the runner and other tests rely on.
	for _, want := range []string{
		"in your own voice",
		"one or two short sentences",
		`{"action":"speak","message":"..."} or {"action":"pass"}`,
		`{"action":"agree","target":"living-player-id","message":"..."}`,
	} {
		if !strings.Contains(socialDiscussion, want) {
			t.Fatalf("social discussion contract lost %q: %q", want, socialDiscussion)
		}
	}
	// The social arm describes the shape of the utterance instead of printing a budget the model
	// would simply fill.
	if strings.Contains(socialDiscussion, "at most 480 characters") {
		t.Fatalf("social discussion contract kept the numeric budget: %q", socialDiscussion)
	}
	if !strings.Contains(thoughtGuidance(StyleSocial), "who benefits if that player falls") {
		t.Fatalf("social thought guidance lost the vote-reading prompt: %q", thoughtGuidance(StyleSocial))
	}
	socialFinal := actionContract(contractGame(t, game.FinalStatements), StyleSocial)
	if !strings.Contains(socialFinal, `{"action":"declare","target":"living-player-id","message":"..."}`) {
		t.Fatalf("social final statement does not request a declaration: %q", socialFinal)
	}
	if strings.Contains(socialFinal, "at most 500 characters") {
		t.Fatalf("social final statement kept the numeric budget: %q", socialFinal)
	}

	// The assembled prompts differ for the same game state.
	g := discussionGameForPrompt(t)
	speaker := g.CurrentSpeaker()
	classic, err := BuildActionPrompt(g, PlayerPrompt{ID: speaker}, StyleClassic)
	if err != nil {
		t.Fatal(err)
	}
	social, err := BuildActionPrompt(g, PlayerPrompt{ID: speaker}, StyleSocial)
	if err != nil {
		t.Fatal(err)
	}
	if classic == social {
		t.Fatal("the social prompt is identical to the classic prompt")
	}
	if !strings.Contains(classic, "do not make it again in your own words") {
		t.Fatalf("classic prompt lost its anti-echo wording: %s", classic)
	}
	if strings.Contains(social, "do not make it again in your own words") {
		t.Fatalf("social prompt still carries the classic anti-echo wording: %s", social)
	}
}

// TestPromptArmsCarryRoleCraftAndPlanLimit checks the role-aware craft blocks and the
// corrected werewolf-plan length, which applies to both arms.
func TestPromptArmsCarryRoleCraftAndPlanLimit(t *testing.T) {
	for _, style := range []PromptStyle{StyleClassic, StyleSocial} {
		plan := actionContract(contractGame(t, game.WerewolfPlanning), style)
		if !strings.Contains(plan, "limited to 480 characters") {
			t.Fatalf("%s werewolf plan contract does not state the real 480 limit: %q", style, plan)
		}
		if strings.Contains(plan, "320 characters") {
			t.Fatalf("%s werewolf plan contract still claims 320 characters: %q", style, plan)
		}
	}

	g := testGameForPrompt(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	var wolf, seer, villager string
	for _, player := range g.Players() {
		switch role, _ := g.RoleFor(player.ID); role {
		case game.Werewolf:
			if wolf == "" {
				wolf = player.ID
			}
		case game.Seer:
			seer = player.ID
		case game.Villager:
			if villager == "" {
				villager = player.ID
			}
		}
	}
	prompt := func(id string, style PromptStyle) string {
		t.Helper()
		built, err := BuildActionPrompt(g, PlayerPrompt{ID: id, Name: id}, style)
		if err != nil {
			t.Fatal(err)
		}
		return built
	}

	for _, want := range []string{"Coordination craft", "vote with a packmate", "counter-accusation can make an accuser look like the manipulator"} {
		if !strings.Contains(prompt(wolf, StyleSocial), want) {
			t.Fatalf("social werewolf brief missing %q", want)
		}
	}
	for _, want := range []string{"Detection craft", "who benefits from a claim", "accusation can be planted"} {
		if !strings.Contains(prompt(villager, StyleSocial), want) {
			t.Fatalf("social villager brief missing %q", want)
		}
		if !strings.Contains(prompt(seer, StyleSocial), want) {
			t.Fatalf("social seer brief missing %q", want)
		}
	}
	if !strings.Contains(prompt(seer, StyleSocial), "Weigh revealing early") {
		t.Fatal("social seer brief does not name the reveal trade-off")
	}
	for _, forbidden := range []string{"Coordination craft", "Detection craft"} {
		if strings.Contains(prompt(wolf, StyleClassic), forbidden) {
			t.Fatalf("classic werewolf brief gained social craft %q", forbidden)
		}
		if strings.Contains(prompt(villager, StyleClassic), forbidden) {
			t.Fatalf("classic villager brief gained social craft %q", forbidden)
		}
	}
}

// TestSocialDiscussionContractAdvertisesOnlyRealActions guards against a phantom verb: the social
// discussion contract once listed "press", which the engine's speak handler never accepted.
func TestSocialDiscussionContractAdvertisesOnlyRealActions(t *testing.T) {
	contract := actionContract(contractGame(t, game.Discussion), StyleSocial)
	if strings.Contains(contract, "press") {
		t.Fatalf("social discussion contract advertises an action the engine forbids: %q", contract)
	}
	for _, advertised := range []string{`"action":"speak"`, `"action":"agree"`, `"action":"pass"`} {
		if !strings.Contains(contract, advertised) {
			t.Fatalf("social discussion contract does not offer %s: %q", advertised, contract)
		}
	}
	// The anti-echo verb ("press, escalate, reframe, or pivot") is a separate instruction and must
	// survive in the block after the transcript.
	if !strings.Contains(antiEchoGuidance(game.Discussion, "", StyleSocial), "press, escalate, reframe, or pivot") {
		t.Fatal("the anti-echo verb was removed along with the phantom action")
	}
}

// TestSocialProtocolLineStatesTurnShapeAndStaysOutOfClassic checks the social arms tell the player
// the shape of the day (rounds, order, position) while the classic arms say none of it.
func TestSocialProtocolLineStatesTurnShapeAndStaysOutOfClassic(t *testing.T) {
	discussion := contractGame(t, game.Discussion)
	social := actionContract(discussion, StyleSocial)
	for _, want := range []string{"every living player speaks once", "in a fixed order that rotates"} {
		if !strings.Contains(social, want) {
			t.Fatalf("social discussion contract omits the turn grammar %q: %q", want, social)
		}
	}
	position, total := discussion.SpeakerPosition()
	if want := fmt.Sprintf("you are the %s of %d to speak this round", ordinal(position), total); !strings.Contains(social, want) {
		t.Fatalf("social discussion contract omits the live position %q: %q", want, social)
	}
	if strings.Contains(actionContract(discussion, StyleClassic), "every living player speaks once") {
		t.Fatal("the classic discussion contract gained the social protocol line")
	}
	if strings.Contains(actionContract(discussion, StyleClassic), "you are the ") {
		t.Fatal("the classic discussion contract leaked the speaker position")
	}

	finalGame := contractGame(t, game.FinalStatements)
	final := actionContract(finalGame, StyleSocial)
	if !strings.Contains(final, "declares the vote they intend to cast, once each") {
		t.Fatalf("social final contract omits the declaration grammar: %q", final)
	}
	position, total = finalGame.SpeakerPosition()
	if want := fmt.Sprintf("you are the %s of %d.", ordinal(position), total); !strings.Contains(final, want) {
		t.Fatalf("social final contract omits the live position %q: %q", want, final)
	}
	if strings.Contains(actionContract(finalGame, StyleClassic), "declares the vote they intend to cast") {
		t.Fatal("the classic final contract gained the social protocol line")
	}
}

func TestParsePromptStyleDefaultsAndRejectsUnknown(t *testing.T) {
	for _, value := range []string{"", "classic"} {
		if style, err := ParsePromptStyle(value); err != nil || style != StyleClassic {
			t.Fatalf("ParsePromptStyle(%q) = %q, %v; want classic", value, style, err)
		}
	}
	if style, err := ParsePromptStyle("social"); err != nil || style != StyleSocial {
		t.Fatalf("ParsePromptStyle(social) = %q, %v", style, err)
	}
	if _, err := ParsePromptStyle("radical"); err == nil {
		t.Fatal("unknown prompt style was accepted")
	}
}

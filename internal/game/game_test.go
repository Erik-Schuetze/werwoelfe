package game

import (
	"fmt"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func testGame(t *testing.T) *Game {
	t.Helper()
	players := make([]Player, 8)
	for i := range players {
		players[i] = Player{ID: string(rune('a' + i)), Name: "Player " + string(rune('A'+i))}
	}
	roles := []Role{Werewolf, Werewolf, Seer, Villager, Villager, Villager, Villager, Villager}
	g, err := New(players, roles, rand.New(rand.NewPCG(1, 2)))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func idWithRole(t *testing.T, g *Game, role Role) string {
	t.Helper()
	for _, player := range g.Players() {
		actual, _ := g.RoleFor(player.ID)
		if actual == role {
			return player.ID
		}
	}
	t.Fatalf("missing role %q", role)
	return ""
}

func advanceToExile(t *testing.T, g *Game) {
	t.Helper()
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	target := g.LivingPlayers()[0].ID
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == Discussion || g.Phase() == FinalStatements {
		action := Action{Type: "pass"}
		if g.Phase() == FinalStatements {
			action = Action{Type: "speak", Message: "My final statement."}
		}
		if err := g.Apply(g.CurrentSpeaker(), action); err != nil {
			t.Fatal(err)
		}
	}
	if g.Phase() != ExileVote {
		t.Fatalf("phase = %q, want exile vote", g.Phase())
	}
}

func advanceFirstNightToDawn(t *testing.T, g *Game) {
	t.Helper()
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	seer := idWithRole(t, g, Seer)
	if err := g.Apply(seer, Action{Type: "investigate", Target: idWithRole(t, g, Werewolf)}); err != nil {
		t.Fatal(err)
	}
	completeWerewolfPlanning(t, g)
	wolves := g.livingRoleIDs(Werewolf)
	target := idWithRole(t, g, Villager)
	for _, wolf := range wolves {
		if err := g.Apply(wolf, Action{Type: "eat", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	if g.Phase() != Dawn {
		t.Fatalf("phase after first dawn = %q, want dawn", g.Phase())
	}
}

func completeWerewolfPlanning(t *testing.T, g *Game) {
	t.Helper()
	for g.Phase() == WerewolfPlanning {
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
}

func completeIntroductions(t *testing.T, g *Game) {
	t.Helper()
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == Introductions {
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "speak", Message: "I am here and will consider running for Sheriff."}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRecommendedRoles(t *testing.T) {
	for _, playerCount := range []int{8, 11, 12, 18} {
		roles := RecommendedRoles(playerCount)
		if err := ValidateRoles(roles, playerCount); err != nil {
			t.Fatalf("%d players: %v", playerCount, err)
		}
	}
	if len(RecommendedRoles(11)) != 11 || len(RecommendedRoles(12)) != 12 {
		t.Fatal("recommended roles do not match player count")
	}
}

func TestInvestigationIsPrivate(t *testing.T) {
	g := testGame(t)
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	seer := idWithRole(t, g, Seer)
	wolf := idWithRole(t, g, Werewolf)
	if err := g.Apply(seer, Action{Type: "investigate", Target: wolf}); err != nil {
		t.Fatal(err)
	}
	result := g.nameOf(wolf) + " is a werewolf."
	if !strings.Contains(historyText(g.HistoryFor(seer)), result) {
		t.Fatal("seer did not receive investigation result")
	}
	villager := idWithRole(t, g, Villager)
	if strings.Contains(historyText(g.HistoryFor(villager)), result) {
		t.Fatal("investigation result leaked to villager")
	}
	if strings.Contains(historyText(g.HistoryFor(wolf)), result) {
		t.Fatal("investigation result leaked to werewolf")
	}
}

func TestWerewolvesPlanPrivatelyBeforeChoosingMeal(t *testing.T) {
	g := testGame(t)
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	seer := idWithRole(t, g, Seer)
	if err := g.Apply(seer, Action{Type: "investigate", Target: idWithRole(t, g, Villager)}); err != nil {
		t.Fatal(err)
	}
	if g.Phase() != WerewolfPlanning {
		t.Fatalf("phase = %q, want werewolf planning", g.Phase())
	}
	wolves := g.livingRoleIDs(Werewolf)
	if err := g.Apply(wolves[0], Action{Type: "plan", Message: "Let's remove Player D and keep our stories apart tomorrow."}); err != nil {
		t.Fatal(err)
	}
	plan := "Player " + strings.ToUpper(wolves[0]) + ": Let's remove Player D and keep our stories apart tomorrow."
	if !strings.Contains(historyText(g.HistoryFor(wolves[1])), plan) {
		t.Fatal("werewolf partner did not receive plan")
	}
	villager := idWithRole(t, g, Villager)
	if strings.Contains(historyText(g.HistoryFor(villager)), plan) {
		t.Fatal("werewolf plan leaked to villager")
	}
	completeWerewolfPlanning(t, g)
	if g.Phase() != WerewolfTurn {
		t.Fatalf("phase = %q, want werewolf turn", g.Phase())
	}
	rounds := 0
	for _, event := range g.HistoryFor(wolves[0]) {
		if event.Kind == "werewolf_planning_round_started" {
			rounds++
		}
	}
	if rounds != werewolfPlanningRounds {
		t.Fatalf("planning rounds = %d, want %d", rounds, werewolfPlanningRounds)
	}
}

func TestWerewolfPlansTruncateToThePlanLimit(t *testing.T) {
	g := testGame(t)
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	seer := idWithRole(t, g, Seer)
	if err := g.Apply(seer, Action{Type: "investigate", Target: idWithRole(t, g, Villager)}); err != nil {
		t.Fatal(err)
	}
	wolf := g.CurrentSpeaker()
	if err := g.Apply(wolf, Action{Type: "plan", Message: strings.Repeat("界", werewolfPlanLimit+1)}); err != nil {
		t.Fatal(err)
	}
	last := g.HistoryFor(wolf)[len(g.HistoryFor(wolf))-1]
	if last.Kind != "werewolf_plan" || !strings.HasSuffix(last.Message, speechCutoffSuffix) {
		t.Fatalf("last plan = %#v, want truncated plan", last)
	}
	message := strings.TrimPrefix(last.Message, g.nameOf(wolf)+": ")
	if utf8.RuneCountInString(message) != werewolfPlanLimit {
		t.Fatalf("plan length = %d, want %d", utf8.RuneCountInString(message), werewolfPlanLimit)
	}
	if g.CurrentSpeaker() == wolf {
		t.Fatal("planning turn did not advance")
	}
}

func TestVotesArePublicAndFinalStatementsDoNotLockTargets(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	voter := g.LivingPlayers()[0].ID
	target := g.LivingPlayers()[1].ID
	if err := g.Apply(voter, Action{Type: "vote", Target: target}); err != nil {
		t.Fatal(err)
	}
	vote := g.nameOf(voter) + " votes for " + g.nameOf(target) + "."
	for _, player := range g.LivingPlayers()[1:] {
		if !strings.Contains(historyText(g.HistoryFor(player.ID)), vote) {
			t.Fatalf("player %q did not receive public vote", player.ID)
		}
	}
	for _, player := range g.LivingPlayers()[1:] {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
	voter = g.LivingPlayers()[0].ID
	for g.Phase() == Discussion {
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	if g.Phase() != FinalStatements {
		t.Fatalf("phase = %q, want final statements", g.Phase())
	}
	if err := g.Apply(voter, Action{Type: "speak", Message: "I expect to vote for Player B."}); err != nil {
		t.Fatal(err)
	}
	for g.Phase() == FinalStatements {
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "speak", Message: "I have nothing else to add."}); err != nil {
			t.Fatal(err)
		}
	}
	alternate := g.LivingPlayers()[2].ID
	if err := g.Apply(voter, Action{Type: "vote", Target: alternate}); err != nil {
		t.Fatalf("vote change after final statement was rejected: %v", err)
	}
}

func TestDiscussionRunsThreeRoundsAndFinalStatement(t *testing.T) {
	g := testGame(t)
	advanceToExile(t, g)
	passes := 0
	rounds := 0
	for _, event := range g.HistoryFor("") {
		if event.Kind == "town_hall_pass" {
			passes++
			if !strings.Contains(event.Message, "stays silent.") {
				t.Fatalf("pass event = %q, want roleplay-safe silence", event.Message)
			}
		}
		if event.Kind == "discussion_round_started" {
			rounds++
		}
	}
	if want := len(g.LivingPlayers()) * discussionRounds; passes != want {
		t.Fatalf("pass count = %d, want %d", passes, want)
	}
	if rounds != discussionRounds {
		t.Fatalf("discussion rounds = %d, want %d", rounds, discussionRounds)
	}
}

func TestIntroductionsAreRequiredBeforeSheriffElection(t *testing.T) {
	g := testGame(t)
	if err := g.StartSheriffElection(); err == nil {
		t.Fatal("Sheriff election started before introductions")
	}
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(g.CurrentSpeaker(), Action{Type: "pass"}); err == nil || !strings.Contains(err.Error(), "introduction") {
		t.Fatalf("introduction pass error = %v", err)
	}
	for g.Phase() == Introductions {
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "speak", Message: "I am introducing myself and will run for Sheriff."}); err != nil {
			t.Fatal(err)
		}
	}
	if g.Phase() != Setup {
		t.Fatalf("phase after introductions = %q, want setup", g.Phase())
	}
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	introductions := 0
	for _, event := range g.HistoryFor("") {
		if event.Kind == "player_introduced" {
			introductions++
		}
	}
	if introductions != len(g.Players()) {
		t.Fatalf("introduction events = %d, want %d", introductions, len(g.Players()))
	}
}

func TestSpeakTruncatesToTheDiscussionLimit(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	target := g.LivingPlayers()[0].ID
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
	speaker := g.CurrentSpeaker()
	if err := g.Apply(speaker, Action{Type: "speak", Message: strings.Repeat("界", discussionLimit+1)}); err != nil {
		t.Fatal(err)
	}
	last := g.HistoryFor("")[len(g.HistoryFor(""))-1]
	if !strings.HasSuffix(last.Message, speechCutoffSuffix) {
		t.Fatalf("truncated message = %q, missing cutoff suffix", last.Message)
	}
	message := strings.TrimPrefix(last.Message, g.nameOf(speaker)+": ")
	if utf8.RuneCountInString(message) != discussionLimit {
		t.Fatalf("message length = %d, want %d", utf8.RuneCountInString(message), discussionLimit)
	}
}

func TestSpeechLimitsArePerPhase(t *testing.T) {
	// A final declaration is clipped far more tightly than a discussion speech: it names one
	// target and one reason, not a paragraph.
	if declarationLimit >= discussionLimit {
		t.Fatalf("declaration limit %d should be below the discussion limit %d", declarationLimit, discussionLimit)
	}
	for phase, want := range map[Phase]int{
		Introductions:     introductionLimit,
		Discussion:        discussionLimit,
		WerewolfPlanning:  werewolfPlanLimit,
		SheriffSuccession: sheriffSuccessionLimit,
	} {
		if got := speechLimit(phase); got != want {
			t.Fatalf("speechLimit(%q) = %d, want %d", phase, got, want)
		}
	}
}

func TestDiscussionSpeakerOrderRotatesAndSheriffLeads(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	sheriff := idWithRole(t, g, Werewolf)
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
	leaders := make([]string, 0, discussionRounds)
	orders := make([][]string, 0, discussionRounds)
	recorded := 0
	for g.Phase() == Discussion {
		if g.CurrentSpeaker() == "" {
			t.Fatal("discussion round has no current speaker")
		}
		if len(orders) < g.DiscussionRound() {
			orders = append(orders, append([]string(nil), g.turnOrder...))
			leaders = append(leaders, g.CurrentSpeaker())
			recorded++
		}
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	if recorded != discussionRounds {
		t.Fatalf("recorded %d rounds, want %d", recorded, discussionRounds)
	}
	if leaders[0] != sheriff {
		t.Fatalf("first round leader = %q, want the Sheriff %q", leaders[0], sheriff)
	}
	if leaders[1] == sheriff && leaders[2] == sheriff {
		t.Fatalf("round leaders = %#v, want the Sheriff to open only the first round", leaders)
	}
	if len(orders[0]) != len(g.LivingPlayers()) {
		t.Fatalf("first round order = %#v, want every living player", orders[0])
	}
	if reflect.DeepEqual(orders[0], orders[1]) || reflect.DeepEqual(orders[1], orders[2]) {
		t.Fatalf("turn order did not rotate between rounds: %#v", orders)
	}
}

func TestTruncationEndsOnABoundaryAndNeverSplitsAWord(t *testing.T) {
	sentences := strings.Repeat("Alpha bravo charlie delta echo foxtrot golf. ", 20)
	clipped := truncateText(sentences, discussionLimit)
	if !strings.HasSuffix(clipped, speechCutoffSuffix) {
		t.Fatalf("clipped text = %q, want the neutral cutoff marker", clipped)
	}
	if utf8.RuneCountInString(clipped) > discussionLimit {
		t.Fatalf("clipped text is %d runes, over the %d limit", utf8.RuneCountInString(clipped), discussionLimit)
	}
	if body := strings.TrimSuffix(clipped, speechCutoffSuffix); !strings.HasSuffix(body, ".") {
		t.Fatalf("clip did not end on a sentence: %q", body)
	}
	unpunctuated := strings.Repeat("alpha bravo charlie ", 40)
	body := strings.TrimSuffix(truncateText(unpunctuated, 50), speechCutoffSuffix)
	if body == "" {
		t.Fatal("clip removed the whole message")
	}
	for _, word := range strings.Fields(body) {
		if word != "alpha" && word != "bravo" && word != "charlie" {
			t.Fatalf("clip split a word: %q in %q", word, body)
		}
	}
}

func TestVoteTalliesArePublished(t *testing.T) {
	g := testGame(t)
	advanceToExile(t, g)
	var tallies []string
	for _, event := range g.HistoryFor("") {
		if event.Kind == "votes_tallied" {
			tallies = append(tallies, event.Message)
		}
	}
	if len(tallies) != 1 || tallies[0] != "Votes: Player A 8." {
		t.Fatalf("election tallies = %#v, want a single tally of eight votes for Player A", tallies)
	}
	players := g.LivingPlayers()
	targets := map[string]string{players[0].ID: players[1].ID, players[1].ID: players[0].ID}
	for _, player := range players[2:] {
		targets[player.ID] = players[2].ID
	}
	for _, player := range players {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: targets[player.ID]}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	tallies = nil
	for _, event := range g.HistoryFor("") {
		if event.Kind == "votes_tallied" {
			tallies = append(tallies, event.Message)
		}
	}
	if len(tallies) != 2 {
		t.Fatalf("tallies = %#v, want one for the election and one for the exile", tallies)
	}
	last := strings.TrimSuffix(strings.TrimPrefix(tallies[1], "Votes: "), ".")
	entries := strings.Split(last, ", ")
	if len(entries) != 3 {
		t.Fatalf("exile tally = %q, want the plurality votes and two single votes", tallies[1])
	}
	total := 0
	previous := -1
	for _, entry := range entries {
		count := 0
		if _, err := fmt.Sscanf(entry[strings.LastIndex(entry, " "):], " %d", &count); err != nil {
			t.Fatalf("cannot read a count from %q: %v", entry, err)
		}
		if previous >= 0 && count > previous {
			t.Fatalf("tally %q is not ordered by descending count", tallies[1])
		}
		previous, total = count, total+count
	}
	if total != len(players) {
		t.Fatalf("tally %q counts %d ballots, want %d", tallies[1], total, len(players))
	}
}

func TestSheriffBreaksExileTie(t *testing.T) {
	g := testGame(t)
	advanceToExile(t, g)
	sheriff := g.Sheriff()
	players := g.LivingPlayers()
	first, second := players[0].ID, players[1].ID
	firstVotes := 0
	for _, player := range players {
		target := second
		if player.ID == sheriff || firstVotes < 3 {
			target = first
			if player.ID != sheriff {
				firstVotes++
			}
		}
		if err := g.Apply(player.ID, Action{Type: "vote", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	resolution, err := g.ResolveVote()
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Exiled != first || g.IsAlive(first) {
		t.Fatalf("sheriff tiebreak exiled %q, want %q", resolution.Exiled, first)
	}
}

func TestVictoryWhenWerewolvesAreEliminated(t *testing.T) {
	g := testGame(t)
	for _, player := range g.Players() {
		role, _ := g.RoleFor(player.ID)
		if role == Werewolf {
			g.alive[player.ID] = false
		}
	}
	if !g.checkVictory() || g.Phase() != Finished || g.Winner() != "townsfolk" {
		t.Fatalf("winner = %q, phase = %q", g.Winner(), g.Phase())
	}
}

func TestRemovedSheriffAppointsSuccessor(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	sheriff := g.LivingPlayers()[0].ID
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	if g.Phase() != Setup {
		t.Fatalf("phase after Sheriff election = %q, want setup before the first night", g.Phase())
	}
	advanceFirstNightToDawn(t, g)
	g.kill(sheriff, "was removed for this test")
	if g.Phase() != SheriffSuccession || g.SheriffPredecessor() != sheriff {
		t.Fatalf("phase = %q, predecessor = %q", g.Phase(), g.SheriffPredecessor())
	}
	successor := g.LivingPlayers()[0].ID
	if err := g.Apply(sheriff, Action{Type: "appoint_sheriff", Target: successor}); err != nil {
		t.Fatal(err)
	}
	if g.Sheriff() != successor || g.Phase() != Dawn {
		t.Fatalf("sheriff = %q, phase = %q", g.Sheriff(), g.Phase())
	}
}

func TestFirstNightAndDawnPrecedeFirstDiscussion(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	sheriff := g.LivingPlayers()[0].ID
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}

	positions := make(map[string]int)
	for index, event := range g.HistoryFor("") {
		switch event.Kind {
		case "introductions_completed", "sheriff_elected", "night_started", "dawn_started", "discussion_started":
			positions[event.Kind] = index
		}
	}
	for _, kind := range []string{"introductions_completed", "sheriff_elected", "night_started", "dawn_started", "discussion_started"} {
		if _, found := positions[kind]; !found {
			t.Fatalf("missing %q event", kind)
		}
	}
	if !(positions["introductions_completed"] < positions["sheriff_elected"] &&
		positions["sheriff_elected"] < positions["night_started"] &&
		positions["night_started"] < positions["dawn_started"] &&
		positions["dawn_started"] < positions["discussion_started"]) {
		t.Fatalf("unexpected opening event order: %#v", positions)
	}
}

func TestTiedWerewolfChoiceUsesDeterministicTiebreak(t *testing.T) {
	g := testGame(t)
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	seer := idWithRole(t, g, Seer)
	if err := g.Apply(seer, Action{Type: "investigate", Target: idWithRole(t, g, Villager)}); err != nil {
		t.Fatal(err)
	}
	completeWerewolfPlanning(t, g)

	wolves := g.livingRoleIDs(Werewolf)
	targets := g.livingRoleIDs(Villager)
	if err := g.Apply(wolves[0], Action{Type: "eat", Target: targets[1]}); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(wolves[1], Action{Type: "eat", Target: targets[0]}); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatalf("resolve tied werewolf choice: %v", err)
	}
	if g.pendingMeal != targets[0] {
		t.Fatalf("pending meal = %q, want deterministic target %q", g.pendingMeal, targets[0])
	}
	if !strings.Contains(historyText(g.HistoryFor(wolves[0])), "deterministic tiebreak") {
		t.Fatal("werewolves did not receive their tiebreak event")
	}
	if strings.Contains(historyText(g.HistoryFor(targets[0])), "deterministic tiebreak") {
		t.Fatal("werewolf tiebreak leaked to a villager")
	}
}

func TestPublicHistoryRevealsEliminatedRole(t *testing.T) {
	g := testGame(t)
	target := idWithRole(t, g, Villager)
	g.kill(target, "was removed for this test")

	want := g.nameOf(target) + " was removed for this test. They were a villager."
	if !strings.Contains(historyText(g.HistoryFor("")), want) {
		t.Fatalf("public history does not reveal eliminated role %q", want)
	}
	event := g.HistoryFor("")[len(g.HistoryFor(""))-1]
	if event.Kind != "player_removed" || event.PlayerID != target || event.RevealedRole != Villager {
		t.Fatalf("elimination event metadata = %#v", event)
	}
}

func historyText(events []Event) string {
	var messages []string
	for _, event := range events {
		messages = append(messages, event.Message)
	}
	return strings.Join(messages, "\n")
}

func countEventKind(g *Game, kind string) int {
	count := 0
	for _, event := range g.HistoryFor("") {
		if event.Kind == kind {
			count++
		}
	}
	return count
}

// electSheriff drives the village through an election and returns the elected id.
func electSheriff(t *testing.T, g *Game, target string) {
	t.Helper()
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	if g.Sheriff() != target {
		t.Fatalf("sheriff = %q, want %q", g.Sheriff(), target)
	}
}

func TestDawnAnnouncedOnceWhenSheriffIsEaten(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	sheriff := idWithRole(t, g, Villager)
	electSheriff(t, g, sheriff)

	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(idWithRole(t, g, Seer), Action{Type: "investigate", Target: idWithRole(t, g, Werewolf)}); err != nil {
		t.Fatal(err)
	}
	completeWerewolfPlanning(t, g)
	for _, wolf := range g.livingRoleIDs(Werewolf) {
		if err := g.Apply(wolf, Action{Type: "eat", Target: sheriff}); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	if g.Phase() != SheriffSuccession {
		t.Fatalf("phase = %q, want sheriff succession", g.Phase())
	}
	successor := g.LivingPlayers()[0].ID
	if err := g.Apply(sheriff, Action{Type: "appoint_sheriff", Target: successor, Message: "Take the sash."}); err != nil {
		t.Fatal(err)
	}
	if g.Phase() != Dawn {
		t.Fatalf("phase after appointment = %q, want dawn", g.Phase())
	}
	// The runner re-enters ResolveDawn after the succession; it must not re-announce dawn.
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	if got := countEventKind(g, "dawn_started"); got != 1 {
		t.Fatalf("dawn_started events = %d, want 1", got)
	}
}

func TestDawnAnnouncedOnceWithoutSheriff(t *testing.T) {
	g := testGame(t)
	if err := g.StartNight(); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(idWithRole(t, g, Seer), Action{Type: "investigate", Target: idWithRole(t, g, Werewolf)}); err != nil {
		t.Fatal(err)
	}
	completeWerewolfPlanning(t, g)
	for _, wolf := range g.livingRoleIDs(Werewolf) {
		if err := g.Apply(wolf, Action{Type: "eat", Target: idWithRole(t, g, Villager)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.ResolveWerewolfChoice(); err != nil {
		t.Fatal(err)
	}
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	// A redundant call must be a no-op rather than a second announcement.
	if err := g.ResolveDawn(); err != nil {
		t.Fatal(err)
	}
	if got := countEventKind(g, "dawn_started"); got != 1 {
		t.Fatalf("dawn_started events = %d, want 1", got)
	}
}

func TestSheriffAppointmentIsLogged(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	sheriff := idWithRole(t, g, Villager)
	electSheriff(t, g, sheriff)
	g.kill(sheriff, "was removed for this test")
	if g.Phase() != SheriffSuccession {
		t.Fatalf("phase = %q, want sheriff succession", g.Phase())
	}
	successor := g.LivingPlayers()[0].ID
	if err := g.Apply(sheriff, Action{Type: "appoint_sheriff", Target: successor, Message: "They can be trusted."}); err != nil {
		t.Fatal(err)
	}
	events := g.HistoryFor("")
	appointed := -1
	succeeded := -1
	for index, event := range events {
		switch event.Kind {
		case "sheriff_appointed":
			appointed = index
		case "sheriff_succeeded":
			succeeded = index
		}
	}
	if appointed == -1 {
		t.Fatal("sheriff_appointed event was not emitted")
	}
	if succeeded == -1 || appointed > succeeded {
		t.Fatalf("sheriff_appointed (%d) must precede sheriff_succeeded (%d)", appointed, succeeded)
	}
	message := events[appointed].Message
	for _, want := range []string{g.nameOf(sheriff), g.nameOf(successor), "They can be trusted."} {
		if !strings.Contains(message, want) {
			t.Fatalf("sheriff_appointed message %q missing %q", message, want)
		}
	}
}

func advanceToDiscussion(t *testing.T, g *Game) {
	t.Helper()
	completeIntroductions(t, g)
	if err := g.StartSheriffElection(); err != nil {
		t.Fatal(err)
	}
	target := g.LivingPlayers()[0].ID
	for _, player := range g.LivingPlayers() {
		if err := g.Apply(player.ID, Action{Type: "vote", Target: target}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := g.ResolveVote(); err != nil {
		t.Fatal(err)
	}
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
}

func TestAgreementIsPublicAndValidated(t *testing.T) {
	g := testGame(t)
	advanceToDiscussion(t, g)
	speaker := g.CurrentSpeaker()
	target := g.LivingPlayers()[0].ID
	if speaker == target {
		target = g.LivingPlayers()[1].ID
	}
	if err := g.Apply(speaker, Action{Type: "agree"}); err == nil {
		t.Fatal("an agreement without a target was accepted")
	}
	if err := g.Apply(speaker, Action{Type: "agree", Target: speaker}); err == nil {
		t.Fatal("a player was allowed to agree with themselves")
	}
	if err := g.Apply(speaker, Action{Type: "agree", Target: "nobody"}); err == nil {
		t.Fatal("an agreement with an unknown player was accepted")
	}
	if err := g.Apply(speaker, Action{Type: "agree", Target: target, Message: strings.Repeat("界", agreementLimit+20)}); err != nil {
		t.Fatal(err)
	}
	history := g.HistoryFor("")
	last := history[len(history)-1]
	if last.Kind != "town_hall_agreement" || last.Visibility != Public {
		t.Fatalf("agreement event = %#v, want a public town_hall_agreement", last)
	}
	want := g.nameOf(speaker) + " agrees with " + g.nameOf(target) + ": "
	if !strings.HasPrefix(last.Message, want) {
		t.Fatalf("agreement message = %q, want prefix %q", last.Message, want)
	}
	body := strings.TrimPrefix(last.Message, want)
	if utf8.RuneCountInString(body) != agreementLimit {
		t.Fatalf("agreement note = %d runes, want it capped at %d", utf8.RuneCountInString(body), agreementLimit)
	}
	if g.CurrentSpeaker() == speaker {
		t.Fatal("agreeing did not advance the speaker")
	}
}

func TestAgreementWithoutWordsReadsAsANod(t *testing.T) {
	g := testGame(t)
	advanceToDiscussion(t, g)
	speaker := g.CurrentSpeaker()
	target := g.LivingPlayers()[0].ID
	if speaker == target {
		target = g.LivingPlayers()[1].ID
	}
	if err := g.Apply(speaker, Action{Type: "agree", Target: target}); err != nil {
		t.Fatal(err)
	}
	history := g.HistoryFor("")
	if last := history[len(history)-1]; last.Message != g.nameOf(speaker)+" nods along with "+g.nameOf(target)+"." {
		t.Fatalf("silent agreement = %q, want a nod", last.Message)
	}
}

func TestAgreementIsRejectedOutsideDiscussion(t *testing.T) {
	g := testGame(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	speaker := g.CurrentSpeaker()
	if err := g.Apply(speaker, Action{Type: "agree", Target: g.LivingPlayers()[1].ID}); err == nil {
		t.Fatal("an introduction was allowed to be an agreement")
	}
}

func TestNoSuccessionWhenTheLastWolfIsTheSheriff(t *testing.T) {
	g := testGame(t)
	wolves := make([]string, 0, 2)
	for _, player := range g.Players() {
		if role, _ := g.RoleFor(player.ID); role == Werewolf {
			wolves = append(wolves, player.ID)
		}
	}
	g.sheriff = wolves[0]
	g.kill(wolves[1], "was eaten overnight")
	if g.Phase() == Finished {
		t.Fatal("the game ended while a werewolf still lived")
	}
	g.kill(g.sheriff, "was exiled by the village")
	g.checkVictory()
	if g.Phase() != Finished {
		t.Fatalf("phase = %q, want the game to be finished", g.Phase())
	}
	if g.SheriffPredecessor() != "" {
		t.Fatalf("sheriff predecessor = %q, want it cleared", g.SheriffPredecessor())
	}
	for _, event := range g.HistoryFor("") {
		if event.Kind == "sheriff_succession_required" {
			t.Fatalf("the game announced a succession it never resolves: %#v", event)
		}
	}
}

func TestSuccessionStillFiresWhenTheGameContinues(t *testing.T) {
	g := testGame(t)
	g.sheriff = g.LivingPlayers()[0].ID
	g.kill(g.sheriff, "was exiled by the village")
	if g.Phase() != SheriffSuccession {
		t.Fatalf("phase = %q, want the removed Sheriff to name a successor", g.Phase())
	}
	if g.SheriffPredecessor() != g.Players()[0].ID && g.SheriffPredecessor() == "" {
		t.Fatal("the removed Sheriff was not recorded as the predecessor")
	}
}

func TestThoughtIsPrivateAndLoggedOnce(t *testing.T) {
	g := testGame(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	speaker := g.CurrentSpeaker()
	other := g.LivingPlayers()[1].ID
	if speaker == other {
		other = g.LivingPlayers()[2].ID
	}
	if err := g.Apply(speaker, Action{Type: "speak", Message: "I am here.", Thought: "I intend to run, but I will not say so yet."}); err != nil {
		t.Fatal(err)
	}
	thoughts := 0
	for _, event := range g.HistoryFor(speaker) {
		if event.Kind != "player_thought" {
			continue
		}
		thoughts++
		if event.Visibility != Private || len(event.Recipients) != 1 || event.Recipients[0] != speaker {
			t.Fatalf("thought event = %#v, want private to %q", event, speaker)
		}
		if !strings.HasSuffix(event.Message, "I intend to run, but I will not say so yet.") {
			t.Fatalf("thought event = %q, want the reasoning text", event.Message)
		}
	}
	if thoughts != 1 {
		t.Fatalf("thought events = %d, want 1", thoughts)
	}
	if strings.Contains(historyText(g.HistoryFor("")), "I intend to run") {
		t.Fatal("thought leaked into public history")
	}
	if strings.Contains(historyText(g.HistoryFor(other)), "I intend to run") {
		t.Fatal("thought leaked into another player's history")
	}
}

func TestRejectedActionDoesNotLogThought(t *testing.T) {
	g := testGame(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	speaker := g.CurrentSpeaker()
	if err := g.Apply(speaker, Action{Type: "pass", Thought: "A thought that must not be stored."}); err == nil {
		t.Fatal("introduction pass was accepted")
	}
	for _, event := range g.HistoryFor(speaker) {
		if event.Kind == "player_thought" {
			t.Fatalf("rejected action stored a thought: %#v", event)
		}
	}
}

func TestThoughtIsClippedAndEmptyIsIgnored(t *testing.T) {
	g := testGame(t)
	if err := g.StartIntroductions(); err != nil {
		t.Fatal(err)
	}
	speaker := g.CurrentSpeaker()
	if err := g.Apply(speaker, Action{Type: "speak", Message: "I am here."}); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(g.CurrentSpeaker(), Action{Type: "speak", Message: "And I am here.", Thought: strings.Repeat("界", thoughtLimit+10)}); err != nil {
		t.Fatal(err)
	}
	thoughts := make([]Event, 0, 1)
	for _, event := range g.history {
		if event.Kind == "player_thought" {
			thoughts = append(thoughts, event)
		}
	}
	if len(thoughts) != 1 {
		t.Fatalf("thought events = %d, want only the one attached to the second action", len(thoughts))
	}
	body := strings.TrimPrefix(thoughts[0].Message, g.nameOf(thoughts[0].Recipients[0])+": ")
	if utf8.RuneCountInString(body) != thoughtLimit {
		t.Fatalf("thought = %q, want it clipped to %d runes", body, thoughtLimit)
	}
}

// advanceToFinalStatements drives the village to the final-statements phase: the discussion runs
// its full course and hands off without a vote.
func advanceToFinalStatements(t *testing.T, g *Game) {
	t.Helper()
	advanceToDiscussion(t, g)
	for g.Phase() == Discussion {
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	if g.Phase() != FinalStatements {
		t.Fatalf("phase = %q, want final statements", g.Phase())
	}
}

func TestFinalDeclarationIsPublicAndNonBinding(t *testing.T) {
	g := testGame(t)
	advanceToFinalStatements(t, g)
	speaker := g.CurrentSpeaker()
	target := g.LivingPlayers()[0].ID
	if target == speaker {
		target = g.LivingPlayers()[1].ID
	}
	if err := g.Apply(speaker, Action{Type: "declare", Target: target, Message: "Their story keeps changing"}); err != nil {
		t.Fatal(err)
	}
	history := g.HistoryFor("")
	last := history[len(history)-1]
	want := g.nameOf(speaker) + " will vote for " + g.nameOf(target) + ": Their story keeps changing."
	if last.Kind != "final_declaration" || last.Visibility != Public || last.Message != want {
		t.Fatalf("declaration event = %#v, want kind final_declaration and message %q", last, want)
	}
	if g.CurrentSpeaker() == speaker {
		t.Fatal("declaring did not advance the speaker")
	}
	// Every other player also declares, then the village votes.
	for g.Phase() == FinalStatements {
		other := g.LivingPlayers()[0].ID
		if other == g.CurrentSpeaker() {
			other = g.LivingPlayers()[1].ID
		}
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "declare", Target: other, Message: "One reason."}); err != nil {
			t.Fatal(err)
		}
	}
	// The declaration must not lock the ballot: voting for someone else still works.
	alternate := g.LivingPlayers()[1].ID
	if alternate == target || alternate == speaker {
		alternate = g.LivingPlayers()[2].ID
	}
	if err := g.Apply(speaker, Action{Type: "vote", Target: alternate}); err != nil {
		t.Fatalf("vote after a different declaration was rejected: %v", err)
	}
}

func TestFinalDeclarationTruncatesToTheDeclarationLimit(t *testing.T) {
	g := testGame(t)
	advanceToFinalStatements(t, g)
	speaker := g.CurrentSpeaker()
	target := g.LivingPlayers()[0].ID
	if target == speaker {
		target = g.LivingPlayers()[1].ID
	}
	if err := g.Apply(speaker, Action{Type: "declare", Target: target, Message: strings.Repeat("界", declarationLimit+1)}); err != nil {
		t.Fatal(err)
	}
	history := g.HistoryFor("")
	body := strings.TrimPrefix(history[len(history)-1].Message, g.nameOf(speaker)+" will vote for "+g.nameOf(target)+": ")
	if !strings.HasSuffix(body, speechCutoffSuffix+".") {
		t.Fatalf("declaration reason = %q, want it clipped by the declaration limit", body)
	}
}

func TestFinalDeclarationTrimsATrailingFullStopFromTheReason(t *testing.T) {
	g := testGame(t)
	advanceToFinalStatements(t, g)
	speaker := g.CurrentSpeaker()
	target := g.LivingPlayers()[0].ID
	if target == speaker {
		target = g.LivingPlayers()[1].ID
	}
	// Models habitually end the reason with a full stop; the rendered message must not double it.
	if err := g.Apply(speaker, Action{Type: "declare", Target: target, Message: "Their story keeps changing."}); err != nil {
		t.Fatal(err)
	}
	history := g.HistoryFor("")
	message := history[len(history)-1].Message
	want := g.nameOf(speaker) + " will vote for " + g.nameOf(target) + ": Their story keeps changing."
	if message != want {
		t.Fatalf("declaration = %q, want %q", message, want)
	}
	if strings.HasSuffix(message, "..") || !strings.HasSuffix(message, ".") {
		t.Fatalf("declaration does not end in exactly one full stop: %q", message)
	}
}

func TestFinalStatementSpeakDegradesToADeclaration(t *testing.T) {
	g := testGame(t)
	advanceToFinalStatements(t, g)
	speaker := g.CurrentSpeaker()
	// A speak in the final beat is a shape mismatch, not a fatal one: it degrades rather than
	// burning a retry.
	if err := g.Apply(speaker, Action{Type: "speak", Message: "I have nothing else to add"}); err != nil {
		t.Fatalf("final-statement speak was rejected instead of degrading: %v", err)
	}
	history := g.HistoryFor("")
	last := history[len(history)-1]
	want := g.nameOf(speaker) + " declares: I have nothing else to add."
	if last.Kind != "final_declaration" || last.Message != want {
		t.Fatalf("degraded declaration = %#v, want %q", last, want)
	}
	if g.CurrentSpeaker() == speaker {
		t.Fatal("a degraded declaration did not advance the speaker")
	}
}

func TestFinalDeclarationRejectsBadTargetsAndOtherActions(t *testing.T) {
	g := testGame(t)
	advanceToFinalStatements(t, g)
	speaker := g.CurrentSpeaker()
	other := g.LivingPlayers()[0].ID
	if other == speaker {
		other = g.LivingPlayers()[1].ID
	}
	if err := g.Apply(speaker, Action{Type: "declare", Target: speaker, Message: "reason"}); err == nil {
		t.Fatal("a player was allowed to declare their own name")
	}
	if err := g.Apply(speaker, Action{Type: "declare", Target: "nobody", Message: "reason"}); err == nil {
		t.Fatal("a declaration with an unknown target was accepted")
	}
	if err := g.Apply(speaker, Action{Type: "declare", Target: other}); err == nil {
		t.Fatal("a declaration with no reason was accepted")
	}
	if err := g.Apply(speaker, Action{Type: "pass"}); err == nil {
		t.Fatal("pass was accepted during final statements")
	}
	if err := g.Apply(speaker, Action{Type: "agree", Target: other}); err == nil {
		t.Fatal("agree was accepted during final statements")
	}
	if g.CurrentSpeaker() != speaker {
		t.Fatal("a rejected action advanced the speaker")
	}
}

func TestSpeakerPositionTracksRoundOrderAndSheriffLead(t *testing.T) {
	g := testGame(t)
	completeIntroductions(t, g)
	sheriff := idWithRole(t, g, Werewolf)
	electSheriff(t, g, sheriff)
	advanceFirstNightToDawn(t, g)
	if err := g.StartDiscussion(); err != nil {
		t.Fatal(err)
	}
	leaders := make([]string, 0, discussionRounds)
	expected := 1
	for g.Phase() == Discussion {
		position, total := g.SpeakerPosition()
		if total != len(g.LivingPlayers()) {
			t.Fatalf("round total = %d, want %d living players", total, len(g.LivingPlayers()))
		}
		if position != expected {
			t.Fatalf("speaker position = %d, want %d", position, expected)
		}
		if position == 1 {
			leaders = append(leaders, g.CurrentSpeaker())
		}
		expected++
		if expected > total {
			expected = 1
		}
		if err := g.Apply(g.CurrentSpeaker(), Action{Type: "pass"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(leaders) != discussionRounds {
		t.Fatalf("recorded %d round leaders, want %d", len(leaders), discussionRounds)
	}
	// The Sheriff opens the first round and then takes a place in the rotation.
	if leaders[0] != sheriff {
		t.Fatalf("first round opened by %q, want the Sheriff %q", leaders[0], sheriff)
	}
	if leaders[1] == sheriff && leaders[2] == sheriff {
		t.Fatalf("round leaders = %#v, want the Sheriff to open only the first round", leaders)
	}
	if g.DiscussionRounds() != discussionRounds {
		t.Fatalf("DiscussionRounds() = %d, want %d", g.DiscussionRounds(), discussionRounds)
	}
}

func TestSpeakerPositionIsZeroWhenNoRoundRuns(t *testing.T) {
	g := testGame(t)
	if position, total := g.SpeakerPosition(); position != 0 || total != 0 {
		t.Fatalf("SpeakerPosition() = (%d, %d), want (0, 0) outside a speaking round", position, total)
	}
}

func TestRecordCharacterIsPrivateToItsPlayer(t *testing.T) {
	g := testGame(t)
	const character = "A cautious archivist who trusts paperwork over people."
	if err := g.RecordCharacter("a", character); err != nil {
		t.Fatal(err)
	}
	private := 0
	for _, event := range g.HistoryFor("a") {
		if event.Kind == "character_defined" {
			private++
		}
	}
	if private != 1 {
		t.Fatalf("character_defined events for the owner = %d, want 1", private)
	}
	if countEventKind(g, "character_defined") != 0 {
		t.Fatal("character_defined must not appear in public history")
	}
	if !strings.Contains(historyText(g.HistoryFor("a")), character) {
		t.Fatal("player cannot see their own character")
	}
	if strings.Contains(historyText(g.HistoryFor("b")), character) {
		t.Fatal("character leaked to another player")
	}
	if strings.Contains(historyText(g.HistoryFor("")), character) {
		t.Fatal("character leaked into public history")
	}
	if err := g.RecordCharacter("nobody", character); err == nil {
		t.Fatal("unknown player was accepted")
	}
}

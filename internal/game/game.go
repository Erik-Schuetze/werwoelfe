package game

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type Role string

const (
	Werewolf Role = "werewolf"
	Villager Role = "villager"
	Seer     Role = "seer"
)

type Phase string

const (
	Setup             Phase = "setup"
	Introductions     Phase = "introductions"
	SheriffElection   Phase = "sheriff_election"
	SeerTurn          Phase = "seer_turn"
	WerewolfPlanning  Phase = "werewolf_planning"
	WerewolfTurn      Phase = "werewolf_turn"
	Dawn              Phase = "dawn"
	Discussion        Phase = "discussion"
	FinalStatements   Phase = "final_statements"
	ExileVote         Phase = "exile_vote"
	SheriffSuccession Phase = "sheriff_succession"
	Finished          Phase = "finished"
)

type Area string

const (
	TownHall        Area = "town_hall"
	WerewolfMeeting Area = "werewolf_meeting"
	SeerVision      Area = "seer_vision"
)

type Visibility string

const (
	Public  Visibility = "public"
	Private Visibility = "private"
)

const speechCutoffSuffix = " [Time is up.]"

// Per-phase limits for a single utterance. Short turns keep a day readable and match how
// briefly people actually speak in these games; an over-long message is clipped silently
// and never fails a run.
const (
	introductionLimit      = 320
	discussionLimit        = 480
	werewolfPlanLimit      = 480
	sheriffSuccessionLimit = 320
	// declarationLimit caps the reason attached to a final declaration. The engine keeps this
	// as a silent backstop (truncateText is never fatal) rather than printing a number in the
	// prompt, because a stated budget is a budget a model simply fills. It replaces
	// finalStatementLimit for the final-statements phase.
	//
	// Known consequence: the classic arm's contract still advertises "at most 500 characters"
	// for its final statement while the engine now clips a declaration at 200. That mismatch is
	// accepted because the classic arm is not currently being run; the social arm states no
	// number at all.
	declarationLimit = 200
	// characterLimit is the engine-side ceiling for a stored character. The character
	// step enforces its own tighter limit when parsing the generated cast.
	characterLimit = 500
	// thoughtLimit caps the private reasoning a player may attach to an action.
	thoughtLimit = 400

	// discussionRounds is how many times every living player may speak each day.
	discussionRounds = 3
	// werewolfPlanningRounds is how many private rounds the pack gets before choosing.
	werewolfPlanningRounds = 2
	// agreementLimit caps the note attached to an agreement. Agreeing is a nod, not a speech.
	agreementLimit = 120
)

type Player struct {
	ID   string
	Name string
}

type Event struct {
	Sequence     int        `json:"sequence"`
	At           time.Time  `json:"at"`
	Kind         string     `json:"kind"`
	Visibility   Visibility `json:"visibility"`
	Recipients   []string   `json:"recipients,omitempty"`
	PlayerID     string     `json:"player_id,omitempty"`
	RevealedRole Role       `json:"revealed_role,omitempty"`
	Message      string     `json:"message"`
}

type Action struct {
	Type    string `json:"type"`
	Target  string `json:"target,omitempty"`
	Message string `json:"message,omitempty"`
	// Thought is a player's private reasoning for this action. It is never shown to
	// another player and never counts as a claim.
	Thought string `json:"thought,omitempty"`
}

type VoteResolution struct {
	Exiled         string
	Tied           []string
	RequiresRevote bool
	NoExile        bool
}

type Game struct {
	players            []Player
	roles              map[string]Role
	alive              map[string]bool
	phase              Phase
	day                int
	sheriff            string
	sheriffPredecessor string
	resumePhase        Phase
	history            []Event
	votes              map[string]string
	voteCandidates     map[string]bool
	voteRound          int
	eatVotes           map[string]string
	pendingMeal        string
	dawnPending        bool
	werewolfPlanRound  int
	discussionRound    int
	turnOrder          []string
	turnIndex          int
	introductionsDone  bool
	winner             string
	eventObserver      func(Event)
}

func RecommendedRoles(playerCount int) []Role {
	werewolves := 2
	if playerCount >= 12 {
		werewolves = 3
	}
	roles := make([]Role, 0, playerCount)
	for range werewolves {
		roles = append(roles, Werewolf)
	}
	roles = append(roles, Seer)
	for len(roles) < playerCount {
		roles = append(roles, Villager)
	}
	return roles
}

func ValidateRoles(roles []Role, playerCount int) error {
	if len(roles) != playerCount {
		return fmt.Errorf("need %d roles, got %d", playerCount, len(roles))
	}
	seenSeer, wolves := 0, 0
	for _, role := range roles {
		switch role {
		case Werewolf:
			wolves++
		case Seer:
			seenSeer++
		case Villager:
		default:
			return fmt.Errorf("unsupported role %q", role)
		}
	}
	if wolves < 1 || wolves > 4 {
		return fmt.Errorf("need 1 to 4 werewolves, got %d", wolves)
	}
	if seenSeer != 1 {
		return fmt.Errorf("need exactly one fortune teller, got %d", seenSeer)
	}
	return nil
}

func New(players []Player, roles []Role, random *rand.Rand) (*Game, error) {
	if len(players) < 8 || len(players) > 18 {
		return nil, fmt.Errorf("need 8 to 18 players, got %d", len(players))
	}
	if err := ValidateRoles(roles, len(players)); err != nil {
		return nil, err
	}
	g := &Game{
		players: players, roles: make(map[string]Role, len(players)), alive: make(map[string]bool, len(players)),
		phase: Setup, votes: make(map[string]string), eatVotes: make(map[string]string),
	}
	ids := make(map[string]struct{}, len(players))
	for _, player := range players {
		if player.ID == "" || player.Name == "" {
			return nil, errors.New("players need non-empty ids and names")
		}
		if _, exists := ids[player.ID]; exists {
			return nil, fmt.Errorf("duplicate player id %q", player.ID)
		}
		ids[player.ID] = struct{}{}
		g.alive[player.ID] = true
	}
	dealt := append([]Role(nil), roles...)
	random.Shuffle(len(dealt), func(i, j int) { dealt[i], dealt[j] = dealt[j], dealt[i] })
	for index, player := range players {
		g.roles[player.ID] = dealt[index]
	}
	g.addEvent("game_started", Public, nil, fmt.Sprintf("%d players have joined the village.", len(players)))
	return g, nil
}

func (g *Game) Phase() Phase                   { return g.phase }
func (g *Game) Day() int                       { return g.day }
func (g *Game) Sheriff() string                { return g.sheriff }
func (g *Game) SheriffPredecessor() string     { return g.sheriffPredecessor }
func (g *Game) Winner() string                 { return g.winner }
func (g *Game) IsAlive(id string) bool         { return g.alive[id] }
func (g *Game) RoleFor(id string) (Role, bool) { role, ok := g.roles[id]; return role, ok }

func (g *Game) Players() []Player {
	return append([]Player(nil), g.players...)
}

func (g *Game) LivingPlayers() []Player {
	living := make([]Player, 0, len(g.players))
	for _, player := range g.players {
		if g.alive[player.ID] {
			living = append(living, player)
		}
	}
	return living
}

func (g *Game) HistoryFor(playerID string) []Event {
	events := make([]Event, 0, len(g.history))
	for _, event := range g.history {
		if event.Visibility == Public || contains(event.Recipients, playerID) {
			event.Recipients = append([]string(nil), event.Recipients...)
			events = append(events, event)
		}
	}
	return events
}

func (g *Game) SetEventObserver(observer func(Event)) {
	g.eventObserver = observer
	if observer == nil {
		return
	}
	for _, event := range g.history {
		observer(event)
	}
}

func (g *Game) StartSheriffElection() error {
	if g.phase != Setup || !g.introductionsDone {
		return g.phaseError(SheriffElection)
	}
	g.phase = SheriffElection
	g.resetVote(nil)
	g.addEvent("sheriff_election_started", Public, nil, "The village must elect a Sheriff.")
	return nil
}

func (g *Game) StartIntroductions() error {
	if g.phase != Setup || g.introductionsDone {
		return g.phaseError(Introductions)
	}
	g.phase = Introductions
	g.beginSpeakerRound()
	g.addEvent("introductions_started", Public, nil, "Each player must introduce themselves before the Sheriff election.")
	return nil
}

func (g *Game) StartNight() error {
	if g.phase != Setup && g.phase != ExileVote && g.phase != Dawn {
		return g.phaseError(SeerTurn)
	}
	if g.checkVictory() {
		return nil
	}
	g.day++
	g.eatVotes = make(map[string]string)
	g.pendingMeal = ""
	g.dawnPending = false
	g.addEvent("night_started", Public, nil, fmt.Sprintf("Night %d falls.", g.day))
	if g.livingRole(Seer) != "" {
		g.phase = SeerTurn
	} else {
		g.beginWerewolfPlanning()
	}
	return nil
}

func (g *Game) StartDiscussion() error {
	if g.phase != Dawn {
		return g.phaseError(Discussion)
	}
	if g.checkVictory() {
		return nil
	}
	g.phase = Discussion
	g.discussionRound = 1
	g.beginSpeakerRound()
	g.addEvent("discussion_started", Public, nil, "The Town Hall discussion has begun.")
	g.addEvent("discussion_round_started", Public, nil, fmt.Sprintf("Discussion round 1 of %d begins.", discussionRounds))
	return nil
}

// RecordCharacter stores a player's generated in-world character as a private event,
// visible only to that player's own prompts (and the trusted operator console).
func (g *Game) RecordCharacter(playerID, character string) error {
	if _, exists := g.roles[playerID]; !exists {
		return fmt.Errorf("unknown player %q", playerID)
	}
	character = truncateText(character, characterLimit)
	if character == "" {
		return errors.New("character description is required")
	}
	g.addEvent("character_defined", Private, []string{playerID}, g.nameOf(playerID)+": "+character)
	return nil
}

func (g *Game) CurrentSpeaker() string {
	if (g.phase != Introductions && g.phase != Discussion && g.phase != FinalStatements && g.phase != WerewolfPlanning) || g.turnIndex >= len(g.turnOrder) {
		return ""
	}
	return g.turnOrder[g.turnIndex]
}

func (g *Game) DiscussionRound() int { return g.discussionRound }

// DiscussionRounds reports how many discussion rounds each day has.
func (g *Game) DiscussionRounds() int { return discussionRounds }

// SpeakerPosition reports the current speaker's 1-based position and the number of speakers in
// the current round, so a prompt can state the shape of the turn ("you are the 2nd of 7 to speak
// this round") without reaching into the turn order. It returns (0, 0) when no round is running.
func (g *Game) SpeakerPosition() (int, int) {
	if len(g.turnOrder) == 0 || g.turnIndex >= len(g.turnOrder) {
		return 0, 0
	}
	return g.turnIndex + 1, len(g.turnOrder)
}

func (g *Game) AllowedArea(playerID string) (Area, bool) {
	if !g.alive[playerID] && !(g.phase == SheriffSuccession && playerID == g.sheriffPredecessor) {
		return "", false
	}
	switch g.phase {
	case Introductions, Discussion, FinalStatements, SheriffElection, ExileVote:
		return TownHall, true
	case WerewolfTurn:
		if g.roles[playerID] == Werewolf {
			return WerewolfMeeting, true
		}
	case WerewolfPlanning:
		if g.roles[playerID] == Werewolf {
			return WerewolfMeeting, true
		}
	case SeerTurn:
		if g.roles[playerID] == Seer {
			return SeerVision, true
		}
	case SheriffSuccession:
		if playerID == g.sheriffPredecessor {
			return TownHall, true
		}
	}
	return "", false
}

func (g *Game) AreaMembers(area Area) []string {
	switch area {
	case TownHall:
		return g.livingIDs(nil)
	case WerewolfMeeting:
		return g.livingRoleIDs(Werewolf)
	case SeerVision:
		return g.livingRoleIDs(Seer)
	default:
		return nil
	}
}

func (g *Game) Apply(playerID string, action Action) error {
	if !g.alive[playerID] && !(g.phase == SheriffSuccession && playerID == g.sheriffPredecessor) {
		return fmt.Errorf("player %q is dead", playerID)
	}
	var err error
	switch g.phase {
	case SeerTurn:
		err = g.investigate(playerID, action)
	case WerewolfPlanning:
		err = g.plan(playerID, action)
	case WerewolfTurn:
		err = g.eat(playerID, action)
	case Introductions, Discussion, FinalStatements:
		err = g.speak(playerID, action)
	case SheriffElection, ExileVote:
		err = g.vote(playerID, action)
	case SheriffSuccession:
		err = g.appointSheriff(playerID, action)
	default:
		return fmt.Errorf("no action is legal during phase %q", g.phase)
	}
	if err != nil {
		return err
	}
	// The thought is recorded only for an accepted action, so a rejected response that
	// is retried never leaves a stray thought behind.
	g.recordThought(playerID, action.Thought)
	return nil
}

// recordThought stores a player's private reasoning as an event only that player may read.
// It reuses Event.Message, so the event schema, the stored history and the sanitized result
// artifact are all unchanged.
func (g *Game) recordThought(playerID, thought string) {
	thought = strings.TrimSpace(thought)
	if thought == "" {
		return
	}
	g.addEvent("player_thought", Private, []string{playerID}, g.nameOf(playerID)+": "+truncateText(thought, thoughtLimit))
}

func (g *Game) ResolveWerewolfChoice() error {
	if g.phase != WerewolfTurn {
		return g.phaseError(Dawn)
	}
	wolves := g.livingRoleIDs(Werewolf)
	if len(wolves) == 0 {
		g.phase = Dawn
		return nil
	}
	if len(g.eatVotes) != len(wolves) {
		return fmt.Errorf("waiting for %d werewolf choices, got %d", len(wolves), len(g.eatVotes))
	}
	target, tied := highest(g.eatVotes, 1)
	if len(tied) > 1 {
		g.addEvent(
			"meal_choice_tied",
			Private,
			wolves,
			"The werewolves disagreed; the deterministic tiebreak selected "+g.nameOf(target)+".",
		)
	}
	g.pendingMeal = target
	g.dawnPending = true
	g.phase = Dawn
	g.addEvent("meal_chosen", Private, wolves, "The werewolves chose "+g.nameOf(target)+".")
	return nil
}

func (g *Game) ResolveDawn() error {
	if g.phase != Dawn {
		return g.phaseError(Discussion)
	}
	// A dawn is resolved exactly once. When the eaten player is the Sheriff, the
	// phase is diverted into SheriffSuccession and then restored to Dawn; the runner
	// re-enters this method, and without this guard it would announce the dawn twice.
	if !g.dawnPending {
		return nil
	}
	g.dawnPending = false
	g.addEvent("dawn_started", Public, nil, "Dawn breaks over the village.")
	if g.pendingMeal != "" && g.alive[g.pendingMeal] {
		g.kill(g.pendingMeal, "was eaten overnight")
	}
	g.pendingMeal = ""
	g.checkVictory()
	return nil
}

func (g *Game) ResolveVote() (VoteResolution, error) {
	if g.phase != SheriffElection && g.phase != ExileVote {
		return VoteResolution{}, fmt.Errorf("votes cannot be resolved in phase %q", g.phase)
	}
	expected := g.livingIDs(nil)
	if len(g.votes) != len(expected) {
		return VoteResolution{}, fmt.Errorf("waiting for %d votes, got %d", len(expected), len(g.votes))
	}
	weights := make(map[string]int, len(g.votes))
	for _, target := range g.votes {
		weights[target]++
	}
	// Publish the tally so the public record is unambiguous: players were misremembering a
	// Sheriff's five votes as six and building reads on the phantom ballot.
	g.addEvent("votes_tallied", Public, nil, g.voteTallyMessage(weights))
	winner, tied := highestInt(weights, 0)
	if len(tied) == 1 {
		if g.phase == SheriffElection {
			g.sheriff = winner
			g.phase = Setup
			g.addEvent("sheriff_elected", Public, nil, g.nameOf(winner)+" is the Sheriff.")
			return VoteResolution{Exiled: winner}, nil
		}
		g.kill(winner, "was exiled by the village")
		g.checkVictory()
		return VoteResolution{Exiled: winner}, nil
	}
	if g.phase == SheriffElection {
		g.resetVote(tied)
		g.addEvent("sheriff_election_tied", Public, nil, "The Sheriff election is tied; the village will vote again.")
		return VoteResolution{Tied: tied, RequiresRevote: true}, nil
	}
	if g.sheriff != "" && contains(tied, g.votes[g.sheriff]) {
		winner = g.votes[g.sheriff]
		g.kill(winner, "was exiled after the Sheriff's tiebreak")
		g.checkVictory()
		return VoteResolution{Exiled: winner, Tied: tied}, nil
	}
	if g.voteRound == 1 {
		g.resetVote(tied)
		g.addEvent("exile_tied", Public, nil, "The exile vote is tied; only tied players will be considered in a revote.")
		return VoteResolution{Tied: tied, RequiresRevote: true}, nil
	}
	g.phase = Dawn
	g.addEvent("no_exile", Public, nil, "The revote is tied; no one is exiled.")
	return VoteResolution{Tied: tied, NoExile: true}, nil
}

func (g *Game) BeginExileVote() error {
	if g.phase != FinalStatements {
		return g.phaseError(ExileVote)
	}
	g.phase = ExileVote
	g.voteRound = 0
	g.resetVote(nil)
	g.addEvent("exile_vote_started", Public, nil, "The village must vote to exile a player.")
	return nil
}

func (g *Game) investigate(playerID string, action Action) error {
	if g.roles[playerID] != Seer || action.Type != "investigate" {
		return errors.New("only the Fortune Teller may investigate")
	}
	if !g.isLegalTarget(action.Target, nil) {
		return fmt.Errorf("invalid investigation target %q", action.Target)
	}
	g.addEvent("investigation_result", Private, []string{playerID}, g.nameOf(action.Target)+" is a "+string(g.roles[action.Target])+".")
	g.beginWerewolfPlanning()
	return nil
}

func (g *Game) plan(playerID string, action Action) error {
	if playerID != g.CurrentSpeaker() {
		return fmt.Errorf("it is not player %q's turn to plan", playerID)
	}
	if action.Type != "plan" && action.Type != "pass" {
		return errors.New("werewolf planning action must be plan or pass")
	}
	if action.Type == "plan" && action.Message == "" {
		return errors.New("werewolf plan needs a message")
	}
	if action.Type == "plan" {
		action.Message = truncateText(action.Message, werewolfPlanLimit)
	}
	if action.Type == "pass" && action.Message != "" {
		return errors.New("werewolf planning pass cannot include a message")
	}
	wolves := g.livingRoleIDs(Werewolf)
	if action.Type == "plan" {
		g.addEvent("werewolf_plan", Private, wolves, g.nameOf(playerID)+": "+action.Message)
	} else {
		g.addEvent("werewolf_plan_pass", Private, wolves, g.nameOf(playerID)+" stays quiet.")
	}
	g.advanceSpeaker()
	return nil
}

func (g *Game) eat(playerID string, action Action) error {
	if g.roles[playerID] != Werewolf || action.Type != "eat" {
		return errors.New("only a living werewolf may choose a meal")
	}
	if _, voted := g.eatVotes[playerID]; voted {
		return errors.New("werewolf may choose only once")
	}
	if !g.isLegalTarget(action.Target, func(id string) bool { return g.roles[id] != Werewolf }) {
		return fmt.Errorf("invalid meal target %q", action.Target)
	}
	g.eatVotes[playerID] = action.Target
	return nil
}

func (g *Game) speak(playerID string, action Action) error {
	if playerID != g.CurrentSpeaker() {
		return fmt.Errorf("it is not player %q's turn to speak", playerID)
	}
	// The final beat is a declaration, not a speech; handle it separately so the discussion
	// grammar below stays as it was.
	if g.phase == FinalStatements {
		return g.declare(playerID, action)
	}
	if action.Type != "pass" && action.Type != "speak" && action.Type != "agree" {
		return errors.New("discussion action must be speak, pass, or agree")
	}
	if g.phase == Introductions && action.Type != "speak" {
		return errors.New("introduction must be speak")
	}
	switch action.Type {
	case "speak":
		if action.Message == "" {
			return errors.New("speak action needs a message")
		}
		action.Message = truncateText(action.Message, speechLimit(g.phase))
	case "pass":
		if action.Message != "" {
			return errors.New("pass action cannot include a message")
		}
	case "agree":
		if !g.isLegalTarget(action.Target, func(id string) bool { return id != playerID }) {
			return fmt.Errorf("invalid agreement target %q", action.Target)
		}
		action.Message = truncateText(action.Message, agreementLimit)
	}
	switch {
	case g.phase == Introductions:
		g.addEvent("player_introduced", Public, nil, g.nameOf(playerID)+": "+action.Message)
	case action.Type == "speak":
		g.addEvent("town_hall_message", Public, nil, g.nameOf(playerID)+": "+action.Message)
	case action.Type == "agree" && action.Message == "":
		g.addEvent("town_hall_agreement", Public, nil, g.nameOf(playerID)+" nods along with "+g.nameOf(action.Target)+".")
	case action.Type == "agree":
		g.addEvent("town_hall_agreement", Public, nil, g.nameOf(playerID)+" agrees with "+g.nameOf(action.Target)+": "+action.Message)
	default:
		g.addEvent("town_hall_pass", Public, nil, g.nameOf(playerID)+" stays silent.")
	}
	g.advanceSpeaker()
	return nil
}

// declare records a player's final declaration: a public, structured statement of the vote they
// intend to cast, naming a living target and one reason. The declaration is deliberately
// non-binding — it records intent, not a locked ballot, so it never constrains the exile vote
// that follows.
//
// A speak is tolerated here rather than rejected: an unexpected action degrades to a targetless
// declaration so a turn is never lost to a retry over a shape the model got slightly wrong.
func (g *Game) declare(playerID string, action Action) error {
	switch action.Type {
	case "declare":
		if !g.isLegalTarget(action.Target, func(id string) bool { return id != playerID }) {
			return fmt.Errorf("invalid declaration target %q", action.Target)
		}
		reason := strings.TrimSpace(action.Message)
		if reason == "" {
			return errors.New("declaration needs a reason")
		}
		reason = truncateText(reason, declarationLimit)
		g.addEvent("final_declaration", Public, nil, declarationMessage(g.nameOf(playerID)+" will vote for "+g.nameOf(action.Target), reason))
	case "speak":
		// Tolerated fallback: keep the words but drop the target the player never named.
		reason := truncateText(strings.TrimSpace(action.Message), declarationLimit)
		g.addEvent("final_declaration", Public, nil, declarationMessage(g.nameOf(playerID)+" declares", reason))
	default:
		return errors.New("final statement must be declare or speak")
	}
	g.advanceSpeaker()
	return nil
}

// declarationMessage renders a declaration, appending the reason only when there is one. A
// model's free-text reason usually ends in its own full stop, so any trailing sentence-ending
// punctuation (and the space around it) is dropped first: the message ends in exactly one full
// stop rather than reading "..".
func declarationMessage(lead, reason string) string {
	reason = strings.TrimRight(strings.TrimSpace(reason), ".!? \t\n")
	if reason == "" {
		return lead + "."
	}
	return lead + ": " + reason + "."
}

func (g *Game) vote(playerID string, action Action) error {
	if action.Type != "vote" {
		return errors.New("voting action must be vote")
	}
	if _, voted := g.votes[playerID]; voted {
		return errors.New("player may vote only once")
	}
	if !g.isLegalTarget(action.Target, func(id string) bool { return len(g.voteCandidates) == 0 || g.voteCandidates[id] }) {
		return fmt.Errorf("invalid vote target %q", action.Target)
	}
	g.votes[playerID] = action.Target
	g.addEvent("vote_cast", Public, nil, g.nameOf(playerID)+" votes for "+g.nameOf(action.Target)+".")
	return nil
}

func (g *Game) appointSheriff(playerID string, action Action) error {
	if playerID != g.sheriffPredecessor || action.Type != "appoint_sheriff" {
		return errors.New("only the removed Sheriff may appoint a successor")
	}
	if !g.isLegalTarget(action.Target, nil) {
		return fmt.Errorf("invalid Sheriff successor %q", action.Target)
	}
	predecessor := g.sheriffPredecessor
	g.sheriff = action.Target
	g.sheriffPredecessor = ""
	g.phase = g.resumePhase
	g.resumePhase = ""
	if action.Message != "" {
		g.addEvent("sheriff_appointed", Public, nil, g.nameOf(predecessor)+" named "+g.nameOf(action.Target)+" as the new Sheriff, saying: "+truncateText(action.Message, sheriffSuccessionLimit))
	} else {
		g.addEvent("sheriff_appointed", Public, nil, g.nameOf(predecessor)+" named "+g.nameOf(action.Target)+" as the new Sheriff.")
	}
	g.addEvent("sheriff_succeeded", Public, nil, g.nameOf(action.Target)+" is the new Sheriff.")
	return nil
}

func (g *Game) beginSpeakerRound() {
	g.turnOrder = g.speakerOrder()
	g.turnIndex = 0
}

// speakerOrder builds the order for the next round. Discussion rotates its starting
// speaker by round so the same player does not anchor every round and let the table's
// first voice set the agenda; the elected Sheriff opens the first round of a day and then
// takes their place in the rotation. Introduction and final-statement rounds keep one
// stable order.
func (g *Game) speakerOrder() []string {
	order := g.livingIDs(nil)
	if g.phase != Discussion || len(order) == 0 {
		return order
	}
	leader := ""
	if g.sheriff != "" && g.alive[g.sheriff] && g.discussionRound <= 1 {
		leader = g.sheriff
		order = withoutID(order, leader)
	}
	if len(order) > 0 {
		offset := (g.discussionRound - 1) % len(order)
		rotated := make([]string, 0, len(order)+1)
		rotated = append(rotated, order[offset:]...)
		rotated = append(rotated, order[:offset]...)
		order = rotated
	}
	if leader != "" {
		order = append([]string{leader}, order...)
	}
	return order
}

func withoutID(order []string, id string) []string {
	filtered := make([]string, 0, len(order))
	for _, candidate := range order {
		if candidate != id {
			filtered = append(filtered, candidate)
		}
	}
	return filtered
}

// voteTallyMessage renders a ballot result in a fixed order (most votes first, then by name)
// so the published tally is deterministic and easy to read.
func (g *Game) voteTallyMessage(weights map[string]int) string {
	type tally struct {
		name  string
		count int
	}
	tallies := make([]tally, 0, len(weights))
	for id, count := range weights {
		tallies = append(tallies, tally{name: g.nameOf(id), count: count})
	}
	sort.Slice(tallies, func(i, j int) bool {
		if tallies[i].count != tallies[j].count {
			return tallies[i].count > tallies[j].count
		}
		return tallies[i].name < tallies[j].name
	})
	parts := make([]string, 0, len(tallies))
	for _, entry := range tallies {
		parts = append(parts, fmt.Sprintf("%s %d", entry.name, entry.count))
	}
	return "Votes: " + strings.Join(parts, ", ") + "."
}

func (g *Game) beginWerewolfPlanning() {
	wolves := g.livingRoleIDs(Werewolf)
	g.phase = WerewolfPlanning
	g.werewolfPlanRound = 1
	g.turnOrder = append([]string(nil), wolves...)
	g.turnIndex = 0
	g.addEvent("werewolf_planning_started", Private, wolves, "The werewolves may make plans before choosing a meal.")
	g.addEvent("werewolf_planning_round_started", Private, wolves, fmt.Sprintf("Werewolf planning round 1 of %d begins.", werewolfPlanningRounds))
}

func (g *Game) advanceSpeaker() {
	g.turnIndex++
	if g.turnIndex < len(g.turnOrder) {
		return
	}
	if g.phase == Discussion && g.discussionRound < discussionRounds {
		g.discussionRound++
		g.beginSpeakerRound()
		g.addEvent("discussion_round_started", Public, nil, fmt.Sprintf("Discussion round %d of %d begins.", g.discussionRound, discussionRounds))
		return
	}
	if g.phase == WerewolfPlanning {
		if g.werewolfPlanRound < werewolfPlanningRounds {
			g.werewolfPlanRound++
			g.turnOrder = g.livingRoleIDs(Werewolf)
			g.turnIndex = 0
			g.addEvent(
				"werewolf_planning_round_started",
				Private,
				g.livingRoleIDs(Werewolf),
				fmt.Sprintf("Werewolf planning round %d of %d begins.", g.werewolfPlanRound, werewolfPlanningRounds),
			)
			return
		}
		g.phase = WerewolfTurn
		g.turnOrder = nil
		g.turnIndex = 0
		g.addEvent("werewolf_meal_started", Private, g.livingRoleIDs(Werewolf), "The werewolves must now choose a meal.")
		return
	}
	if g.phase == Introductions {
		g.introductionsDone = true
		g.phase = Setup
		g.addEvent("introductions_completed", Public, nil, "All players have introduced themselves. The Sheriff election may begin.")
		return
	}
	if g.phase == Discussion {
		g.phase = FinalStatements
		g.beginSpeakerRound()
		g.addEvent("final_statements_started", Public, nil, "Every living player may make a final statement.")
		return
	}
	g.BeginExileVote()
}

func (g *Game) resetVote(candidates []string) {
	g.votes = make(map[string]string)
	g.voteCandidates = make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		g.voteCandidates[candidate] = true
	}
	g.voteRound++
}

func (g *Game) kill(id, reason string) {
	g.alive[id] = false
	g.addEliminationEvent(
		"player_removed",
		Public,
		nil,
		id,
		g.roles[id],
		g.nameOf(id)+" "+reason+". They were a "+string(g.roles[id])+".",
	)
	if id == g.sheriff {
		g.sheriff = ""
		// A Sheriff who dies as the game ends leaves no succession to resolve; announcing one
		// would record a prompt the moderator never answers.
		if len(g.livingIDs(nil)) > 0 && g.victoryReached() == "" {
			g.sheriffPredecessor = id
			g.resumePhase = g.phase
			g.phase = SheriffSuccession
			g.addEvent("sheriff_succession_required", Public, nil, "The removed Sheriff must name a successor.")
		}
	}
}

// victoryReached reports the winning side without changing any state, so callers can ask
// whether the game is already decided before writing another event.
func (g *Game) victoryReached() string {
	wolves, villagers := 0, 0
	for id, alive := range g.alive {
		if !alive {
			continue
		}
		if g.roles[id] == Werewolf {
			wolves++
		} else {
			villagers++
		}
	}
	if wolves == 0 {
		return "townsfolk"
	}
	if wolves >= villagers {
		return "werewolves"
	}
	return ""
}

func (g *Game) checkVictory() bool {
	winner := g.victoryReached()
	if winner == "" {
		return false
	}
	g.winner, g.phase = winner, Finished
	if winner == "townsfolk" {
		g.addEvent("game_finished", Public, nil, "The townsfolk win.")
	} else {
		g.addEvent("game_finished", Public, nil, "The werewolves win.")
	}
	return true
}

func (g *Game) livingRole(role Role) string {
	ids := g.livingRoleIDs(role)
	if len(ids) == 0 {
		return ""
	}
	return ids[0]
}

func (g *Game) livingRoleIDs(role Role) []string {
	ids := make([]string, 0)
	for _, player := range g.players {
		if g.alive[player.ID] && g.roles[player.ID] == role {
			ids = append(ids, player.ID)
		}
	}
	return ids
}

func (g *Game) livingIDs(restrict map[string]bool) []string {
	ids := make([]string, 0, len(g.players))
	for _, player := range g.players {
		if g.alive[player.ID] && (len(restrict) == 0 || restrict[player.ID]) {
			ids = append(ids, player.ID)
		}
	}
	return ids
}

func (g *Game) isLegalTarget(id string, additional func(string) bool) bool {
	if !g.alive[id] {
		return false
	}
	return additional == nil || additional(id)
}

// speechLimit is the clip for a spoken message. FinalStatements is absent because that phase no
// longer speaks: declare clips its reason with declarationLimit instead.
func speechLimit(phase Phase) int {
	switch phase {
	case Introductions:
		return introductionLimit
	case WerewolfPlanning:
		return werewolfPlanLimit
	case SheriffSuccession:
		return sheriffSuccessionLimit
	case Discussion:
		return discussionLimit
	default:
		return characterLimit
	}
}

// truncateText clips a message to limit runes, preferring to end at a sentence boundary and
// never splitting a word. A mid-word cut severs exactly the claim a player was making, so the
// clip gives up a little length to stay readable instead.
func truncateText(message string, limit int) string {
	if utf8.RuneCountInString(message) <= limit {
		return message
	}
	runes := []rune(message)
	budget := limit - utf8.RuneCountInString(speechCutoffSuffix)
	if budget < 1 {
		budget = limit
	}
	cut := boundaryCut(runes, budget)
	return strings.TrimRight(string(runes[:cut]), " \t\n") + speechCutoffSuffix
}

// boundaryCut returns the index at or before budget that closes a sentence, falling back to a
// word boundary, and finally to the raw budget when the text has neither.
func boundaryCut(runes []rune, budget int) int {
	if budget > len(runes) {
		budget = len(runes)
	}
	// Prefer the last sentence end, but only if it keeps most of the budget; otherwise a long
	// unpunctuated sentence would cost far more text than cutting at a word.
	for index := budget - 1; index > 0; index-- {
		if runes[index] != '.' && runes[index] != '!' && runes[index] != '?' {
			continue
		}
		if index+1 < len(runes) && !unicode.IsSpace(runes[index+1]) {
			continue
		}
		if index+1 >= budget/2 {
			return index + 1
		}
		break
	}
	for index := budget - 1; index > 0; index-- {
		if unicode.IsSpace(runes[index]) {
			return index
		}
	}
	return budget
}

func (g *Game) addEvent(kind string, visibility Visibility, recipients []string, message string) {
	g.addEventWithPlayer(kind, visibility, recipients, "", "", message)
}

func (g *Game) addEliminationEvent(kind string, visibility Visibility, recipients []string, playerID string, revealedRole Role, message string) {
	g.addEventWithPlayer(kind, visibility, recipients, playerID, revealedRole, message)
}

func (g *Game) addEventWithPlayer(kind string, visibility Visibility, recipients []string, playerID string, revealedRole Role, message string) {
	event := Event{
		Sequence: len(g.history) + 1, At: time.Now().UTC(), Kind: kind, Visibility: visibility,
		Recipients: append([]string(nil), recipients...), PlayerID: playerID, RevealedRole: revealedRole,
		Message: message,
	}
	g.history = append(g.history, event)
	if g.eventObserver != nil {
		g.eventObserver(event)
	}
}

func (g *Game) phaseError(expected Phase) error {
	return fmt.Errorf("cannot enter %q from phase %q", expected, g.phase)
}

// NameOf returns the display name for a player id.
func (g *Game) NameOf(id string) string { return g.nameOf(id) }

func (g *Game) nameOf(id string) string {
	for _, player := range g.players {
		if player.ID == id {
			return player.Name
		}
	}
	return id
}

func highest(values map[string]string, min int) (string, []string) {
	counts := make(map[string]int)
	for _, value := range values {
		counts[value]++
	}
	weighted := make(map[string]int, len(counts))
	for target, count := range counts {
		weighted[target] = count
	}
	return highestInt(weighted, min)
}

func highestInt(values map[string]int, min int) (string, []string) {
	best := min - 1
	tied := make([]string, 0)
	for id, value := range values {
		if value > best {
			best, tied = value, []string{id}
		} else if value == best {
			tied = append(tied, id)
		}
	}
	sort.Strings(tied)
	if len(tied) > 0 {
		return tied[0], tied
	}
	return "", nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

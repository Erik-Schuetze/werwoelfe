package model

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/eschuetze/werwoelfe/internal/game"
)

type PlayerPrompt struct {
	ID          string
	Name        string
	Personality string
	Character   string
}

// PromptStyle selects the prompt arm. StyleClassic preserves the original wording
// byte for byte; StyleSocial is the rewritten variant. The variant is chosen by
// config, so both arms are runnable from a single build.
type PromptStyle string

const (
	StyleClassic PromptStyle = "classic"
	StyleSocial  PromptStyle = "social"
)

// ParsePromptStyle maps a config string to a PromptStyle. An empty value means the
// default (classic), matching how config.Load fills in an omitted prompt_style.
func ParsePromptStyle(value string) (PromptStyle, error) {
	switch value {
	case "", string(StyleClassic):
		return StyleClassic, nil
	case string(StyleSocial):
		return StyleSocial, nil
	default:
		return "", fmt.Errorf("unknown prompt style %q", value)
	}
}

const (
	recentEventLimit  = 24
	durableEventLimit = 64
)

// rulesDigest is a compact summary of the rules that apply to the roles used in
// the recommended setup. docs/rules.md remains the official, immutable source; this
// is a short paraphrase so the model is at least grounded in how the game works.
const rulesDigest = `How this game works: hidden among the villagers are Werewolves. Each night the Werewolves secretly agree to eliminate one villager; each night the Fortune Teller secretly learns whether one chosen player is a Werewolf or a villager, where a "villager" result means that player is not a Werewolf. Each day the village talks openly and then votes to exile one player. The village wins when every Werewolf is gone; the Werewolves win when they equal or outnumber everyone else. A player's role is revealed when they are eliminated. The village elects a Sheriff on the first day, and the Sheriff breaks a tied exile vote. You may claim a role or lie about it.`

func BuildActionPrompt(g *game.Game, player PlayerPrompt, style PromptStyle) (string, error) {
	if !g.IsAlive(player.ID) && !(g.Phase() == game.SheriffSuccession && g.SheriffPredecessor() == player.ID) {
		return "", fmt.Errorf("dead player %q cannot receive an action prompt", player.ID)
	}
	role, exists := g.RoleFor(player.ID)
	if !exists {
		return "", fmt.Errorf("unknown player %q", player.ID)
	}
	area, allowed := g.AllowedArea(player.ID)
	if !allowed {
		return "", fmt.Errorf("player %q cannot act during %q", player.ID, g.Phase())
	}
	type publicPlayer struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Alive bool   `json:"alive"`
	}
	players := make([]publicPlayer, 0, len(g.Players()))
	for _, candidate := range g.Players() {
		players = append(players, publicPlayer{ID: candidate.ID, Name: candidate.Name, Alive: g.IsAlive(candidate.ID)})
	}
	durableEvents, recentEvents := promptHistory(g.HistoryFor(player.ID))
	durableHistory, err := json.Marshal(durableEvents)
	if err != nil {
		return "", fmt.Errorf("marshal durable history: %w", err)
	}
	recentHistory, err := json.Marshal(recentEvents)
	if err != nil {
		return "", fmt.Errorf("marshal recent history: %w", err)
	}
	roster, err := json.Marshal(players)
	if err != nil {
		return "", fmt.Errorf("marshal roster: %w", err)
	}
	actionSchema := actionContract(g, style)
	if actionSchema == "" {
		return "", fmt.Errorf("no action contract for phase %q", g.Phase())
	}
	var private string
	switch role {
	case game.Werewolf:
		private = "You are secretly a Werewolf. Your living packmates are: " + strings.Join(g.AreaMembers(game.WerewolfMeeting), ", ") +
			". You may lie about your role, claim to be the Fortune Teller, invent a result you never obtained, or accuse a player you know is innocent. That is expected play, not cheating."
		if style == StyleSocial {
			private += " Coordination craft: vote with a packmate to build one narrative; exploit an accusation already on the table; redirect pressure off a packmate; a well-placed counter-accusation can make an accuser look like the manipulator."
		}
	case game.Seer:
		private = "You are the Fortune Teller. Only you know the results of your investigations."
		if style == StyleSocial {
			private += " Detection craft: ask who benefits from a claim; a too-neat alibi and an over-justified denial are evidence; an accusation can be planted; and a player who turns an accusation back onto its accuser may be deflecting. Weigh revealing early: a confirmed reading is powerful, but it marks you for the pack."
		}
	default:
		private = "You are a villager."
		if style == StyleSocial {
			private += " Detection craft: ask who benefits from a claim; a too-neat alibi and an over-justified denial are evidence; an accusation can be planted. Name the frame-and-deflect when you see it: a player who turns an accusation back onto its accuser may be deflecting."
		}
	}
	name := player.Name
	if name == "" {
		name = g.NameOf(player.ID)
	}
	// The character note governs HOW the player speaks, never WHAT they talk about. It is a
	// manner, not a persona: the generator no longer supplies an occupation (see
	// experiment.characterRequestTemplate), because occupational framing invites "proxy
	// styles" — a surface feature over-selected until it becomes a default route — and
	// suppressing the surfaced token would only relocate the tic ("substitution drift")
	// rather than repair the basin. So the note names no trade and offers no imagery; it
	// only asks the player to carry their manner (pace, directness, how they take a
	// challenge) through the message. Do not add a banned-imagery list here either.
	character := ""
	if strings.TrimSpace(player.Character) != "" {
		character = "\nYour character (light colour only): " + player.Character +
			"\nLet that colour how you phrase things in every message you send, not only your first: it shapes how you speak — your pace, your directness, how you take a challenge — not what you talk about. Do not reach for imagery from a trade, a craft, or everyday objects. Keep it light; the substance stays the game itself."
	}
	return fmt.Sprintf(`You are %s (player %s). Your name is %s. %s%s

%s
%s
You are among fellow villagers in an ongoing game. Everything recorded below is true and replaces anything you inferred earlier: never claim that the moderator recorded something it did not, and never claim a recorded event did not happen. Beyond that record, lying is legal and expected play here — you may claim a role you do not hold, accuse anyone, invent a plausible motive or reading of someone's behaviour, and bluff about your own role. Nobody is punished for deceiving the village.
It is day %d, and you are in %q.
People in the village: %s
Lasting facts your character knows: %s
Recent events your character knows: %s%s

%s

Respond with exactly one JSON object and no markdown. %s`,
		name, player.ID, name, player.Personality, character, private, rulesDigest, g.Day(), area, roster, durableHistory, recentHistory, antiEchoGuidance(g.Phase(), player.Character, style), thoughtGuidance(style), actionSchema), nil
}

// thoughtGuidance is the private-reasoning instruction. The classic arm asks only for
// one or two private sentences; the social arm requires the read to actually be worked
// out (suspects, trust, what the votes were doing, and the intent of this message).
func thoughtGuidance(style PromptStyle) string {
	if style == StyleSocial {
		return `Always include a "thought" field: your private read, at most 400 characters and never shown to any other player: who you suspect and who you trust, and on what evidence; what the recent votes were trying to achieve, and who benefits if that player falls; and what this message is intended to make the others believe. It is not a claim; use it to work out what you are doing, not to perform.`
	}
	return `Always include a "thought" field: one or two private sentences of your own reasoning (at most 400 characters). It is never shown to any other player and is not a claim — use it to work out what you are doing, not to perform.`
}

// antiEchoGuidance is emitted after the transcript, next to the decision it governs. The
// same instruction lives in the system message, but there it sits a bounded history away
// from the moment a player chooses what to say. The voice reminder rides along because a
// register stated at the top of the prompt fades by the second day of argument.
func antiEchoGuidance(phase game.Phase, character string, style PromptStyle) string {
	blocks := make([]string, 0, 2)
	switch phase {
	case game.Discussion, game.FinalStatements:
		if style == StyleSocial {
			blocks = append(blocks, "Before you answer, check what the village has already heard today. Making a case again in the same words wastes the turn, so press, escalate, reframe, or pivot it instead, and change your mind out loud: when your read moves, say what moved it and why. Pressure is not padding but it is not repetition either: if you are building on a case, make this telling do something the last one did not. You may address more than one player when the point requires it.")
		} else {
			blocks = append(blocks, "Before you answer, check what the village has already heard today. If a case has already been made against a player, do not make it again in your own words — either add a fact nobody has used yet, or agree with it in a few words instead. Your own wording still counts as repeating it, and bringing more than one new point wastes the turn. Address at most one player.")
		}
	}
	if strings.TrimSpace(character) != "" {
		blocks = append(blocks, "Keep your own voice in this message too: "+character)
	}
	if len(blocks) == 0 {
		return ""
	}
	return "\n\n" + strings.Join(blocks, "\n")
}

func promptHistory(events []game.Event) ([]game.Event, []game.Event) {
	durable := make([]game.Event, 0, durableEventLimit)
	recent := make([]game.Event, 0, len(events))
	for _, event := range events {
		// The player's own character is rendered separately as "Your character: ...", and
		// the player's own thoughts are private working notes that must not feed back into
		// the loop that produced them. Neither belongs in the recent-events block.
		if event.Kind == "character_defined" || event.Kind == "player_thought" {
			continue
		}
		recent = append(recent, event)
		switch event.Kind {
		case "player_removed", "sheriff_elected", "sheriff_succeeded", "sheriff_appointed", "vote_cast", "votes_tallied",
			"investigation_result", "meal_chosen", "meal_choice_tied", "werewolf_plan":
			durable = append(durable, event)
		}
	}
	if len(durable) > durableEventLimit {
		durable = durable[len(durable)-durableEventLimit:]
	}
	if len(recent) > recentEventLimit {
		recent = recent[len(recent)-recentEventLimit:]
	}
	return durable, recent
}

// protocolLine states the shape of the day in the social arm: how many rounds it runs, that
// every living player speaks once in each round in a rotating order, where the current speaker
// sits in it, and how the day closes. A real player at the table knows these rules, so stating
// them is information rather than coaching. It is written as facts about the game (no
// second-person imperative, no adjectives about suspicion) and is social-only: the classic arm
// renders none of it.
func protocolLine(g *game.Game) string {
	position, total := g.SpeakerPosition()
	if total == 0 {
		return ""
	}
	switch g.Phase() {
	case game.Discussion:
		return fmt.Sprintf(" The day runs %d rounds. In each round every living player speaks once, in a fixed order that rotates; you are the %s of %d to speak this round. After the rounds, every player declares the vote they intend to cast, and then the village votes.", g.DiscussionRounds(), ordinal(position), total)
	case game.FinalStatements:
		return fmt.Sprintf(" The day ran %d rounds, and the discussion is closed. Every living player now declares the vote they intend to cast, once each, in a fixed order; you are the %s of %d. The village then votes.", g.DiscussionRounds(), ordinal(position), total)
	}
	return ""
}

// ordinal renders 1 as "1st", 2 as "2nd", and so on, so a protocol line reads naturally.
func ordinal(n int) string {
	if n%100 >= 11 && n%100 <= 13 {
		return fmt.Sprintf("%dth", n)
	}
	switch n % 10 {
	case 1:
		return fmt.Sprintf("%dst", n)
	case 2:
		return fmt.Sprintf("%dnd", n)
	case 3:
		return fmt.Sprintf("%drd", n)
	default:
		return fmt.Sprintf("%dth", n)
	}
}

// actionContract describes the legal action for the current phase. The classic branches return
// their original wording verbatim and never consult the game; the social branches add a compact
// protocol line stating the shape of the day (see protocolLine). The phase is read from the game
// only to pick the branch.
func actionContract(g *game.Game, style PromptStyle) string {
	switch g.Phase() {
	case game.Introductions:
		return `The villagers are introducing themselves before choosing a Sheriff. Reply with {"action":"speak","message":"..."}. In your message, briefly introduce yourself by name and say whether or why you intend to run for Sheriff. Role claims and bluffing are allowed. One or two short sentences; the message is limited to 320 characters.`
	case game.Discussion:
		if style == StyleSocial {
			return `You may speak, agree or stay silent. Reply with {"action":"speak","message":"..."} or {"action":"pass"}, or, when a case you accept is already on the table, {"action":"agree","target":"living-player-id","message":"..."} with at most a few words of your own. Silence is a normal move too: passing is not suspicious and is often stronger than padding. Speak when you have one concrete thing that moves your own case: one concrete observation, question, or concern, in your own voice, in one or two short sentences. Read what a claim is doing: ask yourself what this message is trying to make you believe, and what its shape suggests about the speaker. Do not narrate the moderator's process or the game's mechanics as such.` + protocolLine(g)
		}
		return `You may speak, agree, or stay silent. Reply with {"action":"speak","message":"..."} or {"action":"pass"}, or — when a case you accept is already on the table — {"action":"agree","target":"living-player-id","message":"..."} with at most a few words of your own. Agreeing is the right answer to a case that has already been made; restating it in your own words wastes the round. Silence is a normal move too: passing is not suspicious and is often stronger than padding. Speak only when you have one concrete thing that moves your own case: one concrete observation, question, or concern, in your own voice, in one or two short sentences (at most 480 characters). Do not narrate game mechanics, judge the wording of another person's message, or repeat a stock case against someone.`
	case game.FinalStatements:
		if style == StyleSocial {
			return `Each villager may declare the vote they intend to cast before the vote; this one is required. Reply with {"action":"declare","target":"living-player-id","message":"..."}, naming the living player you intend to vote for and the single reason for it, in one sentence, in your own voice. The declaration is not binding: it records the vote you intend now, not a locked ballot. Read what a claim is doing: ask yourself what this message is trying to make you believe, and what its shape suggests about the speaker. Do not narrate the moderator's process or the game's mechanics as such.` + protocolLine(g)
		}
		return `Each villager may make a final statement before the vote; this one is required. Reply with {"action":"speak","message":"..."}. Say the one thing you have not yet said. If you have nothing new, name the player you will vote for and the single reason for it, in one sentence, in your own voice, in at most 500 characters. Do not narrate game mechanics, judge the wording of another person's message, or repeat a stock case against someone.`
	case game.SheriffElection, game.ExileVote:
		return `Choose {"action":"vote","target":"living-player-id"}.`
	case game.SheriffSuccession:
		return `You have been removed from the village, but as Sheriff you keep the right to name your successor. Choose the one living player you trust most to carry the badge, and say briefly why you trust them with it. Do not simply name whoever is next in turn; pick the player your own read of the game points to. Reply with {"action":"appoint_sheriff","target":"living-player-id","message":"..."} (the reason is limited to 320 characters).`
	case game.SeerTurn:
		return `Choose {"action":"investigate","target":"living-player-id"}. In your thought, decide whether and when to reveal what you learn.`
	case game.WerewolfPlanning:
		return `This is a private pack meeting. Reply with {"action":"plan","message":"..."} to discuss tonight's target or the pack's public strategy for the coming day, or {"action":"pass"} to remain quiet. Use your thought for your own analysis; put in the plan message only what the whole pack needs to hear. Your message is visible only to living Werewolves and is limited to 480 characters.`
	case game.WerewolfTurn:
		return `Choose {"action":"eat","target":"living-non-werewolf-player-id"}.`
	default:
		return ""
	}
}

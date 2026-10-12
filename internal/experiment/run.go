package experiment

import (
	"context"
	"fmt"
	"math/rand/v2"
	"strings"

	"github.com/eschuetze/werwoelfe/internal/config"
	"github.com/eschuetze/werwoelfe/internal/game"
	"github.com/eschuetze/werwoelfe/internal/model"
)

type CompletionClient interface {
	CompleteJSON(context.Context, []model.Message) (string, error)
}

// TemperatureCompletionClient is an optional capability: a client that can run a
// single request at a temperature other than its configured default. The character
// step uses it when available and falls back to CompleteJSON otherwise.
type TemperatureCompletionClient interface {
	CompleteJSONWithTemperature(context.Context, []model.Message, float64) (string, error)
}

// classicSystemInstruction is the control-arm system message and must stay byte-identical
// to the pre-experiment text. socialSystemInstruction keeps the same framing but rewrites the
// classic arm's em dashes into commas, colons and full stops, and replaces the final clause:
// the social arm invites reading what a claim is doing rather than forbidding judgement of
// another player's message outright.
const classicSystemInstruction = "Play your assigned character in an ongoing Werewolves of Millers Hollow game. You are one of the villagers, speaking with fellow villagers; do not claim that they are real people outside the game. The newest situation from the moderator is the source of truth and replaces earlier assumptions. Never contradict anything the moderator recorded — eliminations, revealed roles, ballots and your private results are true. Everything else you say is a claim: lying, bluffing and false role claims are expected play here, not cheating. When you speak, speak plainly in your own voice and respond to a specific detail, question, or concern instead of copying another speaker's phrasing or explaining the game's mechanics. Keep any character flavour light — at most a few words; the substance of every message must be the game itself. Do not lean on catchphrases, dialect, or repeated metaphors. Do not judge the quality or form of another person's message. Return only the requested JSON action."

const socialSystemInstruction = "Play your assigned character in an ongoing Werewolves of Millers Hollow game. You are one of the villagers, speaking with fellow villagers; do not claim that they are real people outside the game. The newest situation from the moderator is the source of truth and replaces earlier assumptions. Never contradict anything the moderator recorded: eliminations, revealed roles, ballots and your private results are true. Everything else you say is a claim: lying, bluffing and false role claims are expected play here, not cheating. When you speak, speak plainly in your own voice and respond to a specific detail, question, or concern instead of copying another speaker's phrasing or explaining the game's mechanics. Keep any character flavour light: at most a few words; the substance of every message must be the game itself. Do not lean on catchphrases, dialect, or repeated metaphors. Judge what a message is doing, what it is trying to make you believe, rather than the quality or form of how it is written. Return only the requested JSON action."

// systemInstruction returns the system message for the chosen arm. The classic arm is
// unchanged; the social arm rewrites the em-dashed phrasing and replaces the clause about
// judging another player.
func systemInstruction(style model.PromptStyle) string {
	if style == model.StyleSocial {
		return socialSystemInstruction
	}
	return classicSystemInstruction
}

const characterInstruction = "You cast a small village of ordinary people who must each sound clearly different from one another. You are not playing anyone; you only describe how each person speaks and thinks. Never mention or imply any secret role or side. Return only the requested JSON action."

// characterRequestTemplate is formatted with the roster ("<id> (<name>), ...").
//
// The request asks for a manner — how someone speaks and argues — rather than a trade or
// identity, and that wording is deliberate. Asking for "a mundane village occupation plus
// how they talk and think" hands the model a well to draw from, and it then over-fits the
// persona by reaching for occupational imagery in message after message (a woodworker's
// "plank unplaned"). These are "proxy styles": surface features over-selected because they
// satisfy a bundle of constraints cheaply, and the failure is a proxy that "stops being
// context-sensitive and becomes an over-selected default route" ("From Goblins to
// Behavioral Basins"). A longer banned-imagery list would not help: suppressing a surfaced
// token only pushes the attractor onto another token that satisfies the same bundle
// ("substitution drift"). The literature's remedy is "basin repair rather than surface-token
// suppression" — change how the underlying constraint is satisfied — so the fix here is to
// remove the occupation from the prompt, not to enumerate imagery to avoid. Do NOT add a
// banned-imagery list back; it would merely relocate the tic. Identity and communication
// style are separable layers, and communication-level traits (how someone sounds) are best
// pinned down by concrete behaviour, which is why the request now asks for tempo, sentence
// shape and so on. Keep it modest: an understated manner that aligns with the model's
// disposition is stable, whereas an exaggerated character runs against it and flips register.
const characterRequestTemplate = `The players in this village are: %s.

For each player, invent a distinct speaking voice — how this person speaks and argues, not what they talk about. Work from concrete behaviour: tempo (terse to expansive), sentence shape, how direct or circumspect they are, how they open a point, how they handle being challenged or contradicted, and how much they hedge. Give every player a clearly different register so no two sound alike, and spread them across a wide range (terse, warm, formal, wry, earnest, dry, measured, brisk, and others). One short sentence per player, at most 200 characters.

Avoid for every player: physical habits or gestures (no tapping, nodding, or sighing), catchphrases, idioms or repeated metaphors, dialects or accents, and backstory. Never name a trade, profession, craft or area of expertise, and never hand the speaker imagery to draw on — describe only how they talk, not a world to talk about. Never mention or imply any secret role or side.

Reply with {"action":"characters","characters":[{"id":"<player id>","message":"..."}]}.`

// characterLengthLimit caps a generated character so it stays a light flavour note.
const characterLengthLimit = 240

type Runner struct {
	Game                 *game.Game
	Players              map[string]config.Player
	Client               CompletionClient
	MaxRetries           int
	CharacterTemperature float64
	// TitleTemperature is the temperature for the single off-gameplay naming call made
	// after the game ends. Zero disables the call and keeps only the deterministic fallback.
	TitleTemperature float64
	// DefaultTemperature is the run-wide temperature; a player without an explicit
	// temperature inherits it.
	DefaultTemperature float64
	// PromptStyle selects the classic or social prompt arm.
	PromptStyle model.PromptStyle
	// ResponseLog, when set, persists the raw completion for any response that fails to parse or
	// validate, and any failed cast-generation call, so a failed — or silently degraded — run can
	// be explained afterwards. It is best-effort and optional; a nil log records nothing.
	ResponseLog *ResponseLog
	// playerTemperatures holds each player's resolved temperature (explicit, else the
	// run default). Resolving here keeps an explicit 0 distinct from "unset".
	playerTemperatures map[string]float64
	characters         map[string]string
	// title is the run's spoiler-free title: the gated model suggestion, or the
	// deterministic fallback. Set once by generateTitle after the game ends.
	title string
}

func NewRunner(cfg config.Config, client CompletionClient, random *rand.Rand) (*Runner, error) {
	style, err := model.ParsePromptStyle(cfg.Model.PromptStyle)
	if err != nil {
		return nil, err
	}
	players := make([]game.Player, len(cfg.Players))
	byID := make(map[string]config.Player, len(cfg.Players))
	temperatures := make(map[string]float64, len(cfg.Players))
	for index, player := range cfg.Players {
		players[index] = game.Player{ID: player.ID, Name: player.Name}
		byID[player.ID] = player
		temperatures[player.ID] = cfg.Model.Temperature
		if player.Temperature != nil {
			temperatures[player.ID] = *player.Temperature
		}
	}
	g, err := game.New(players, cfg.Roles, random)
	if err != nil {
		return nil, err
	}
	return &Runner{
		Game:                 g,
		Players:              byID,
		Client:               client,
		MaxRetries:           cfg.Model.MaxRetries,
		CharacterTemperature: cfg.Model.CharacterTemperature,
		TitleTemperature:     cfg.Model.TitleTemperature,
		DefaultTemperature:   cfg.Model.Temperature,
		PromptStyle:          style,
		playerTemperatures:   temperatures,
		characters:           make(map[string]string, len(cfg.Players)),
	}, nil
}

// Title returns the run's spoiler-free title: the gated model suggestion, or the
// deterministic fallback when naming was disabled or rejected. It is empty only when the
// game never reached its end.
func (r *Runner) Title() string { return r.title }

func (r *Runner) Run(ctx context.Context) error {
	r.generateCast(ctx)
	if err := r.Game.StartIntroductions(); err != nil {
		return err
	}
	for r.Game.Phase() == game.Introductions {
		if err := r.runCurrentSpeaker(ctx); err != nil {
			return fmt.Errorf("run player introduction: %w", err)
		}
	}
	if err := r.Game.StartSheriffElection(); err != nil {
		return err
	}
	if err := r.runVote(ctx); err != nil {
		return fmt.Errorf("run Sheriff election: %w", err)
	}
	if err := r.Game.StartNight(); err != nil {
		return err
	}
	for r.Game.Phase() != game.Finished {
		switch r.Game.Phase() {
		case game.Discussion, game.FinalStatements, game.WerewolfPlanning:
			if err := r.runCurrentSpeaker(ctx); err != nil {
				return err
			}
		case game.ExileVote:
			if err := r.runVote(ctx); err != nil {
				return fmt.Errorf("run exile vote: %w", err)
			}
			if r.Game.Phase() == game.ExileVote || r.Game.Phase() == game.Dawn {
				if err := r.Game.StartNight(); err != nil {
					return err
				}
			}
		case game.SheriffSuccession:
			if err := r.requestAndApply(ctx, r.Game.SheriffPredecessor()); err != nil {
				return fmt.Errorf("appoint Sheriff successor: %w", err)
			}
			if r.Game.Phase() == game.ExileVote {
				if err := r.Game.StartNight(); err != nil {
					return err
				}
			}
		case game.Dawn:
			if err := r.Game.ResolveDawn(); err != nil {
				return err
			}
			if r.Game.Phase() == game.Dawn {
				if err := r.Game.StartDiscussion(); err != nil {
					return err
				}
			}
		case game.SeerTurn:
			seer := r.playerWithRole(game.Seer)
			if err := r.requestAndApply(ctx, seer); err != nil {
				return err
			}
		case game.WerewolfTurn:
			for _, wolf := range r.playersWithRole(game.Werewolf) {
				if err := r.requestAndApply(ctx, wolf); err != nil {
					return err
				}
			}
			if err := r.Game.ResolveWerewolfChoice(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unexpected active phase %q", r.Game.Phase())
		}
	}
	r.generateTitle(ctx)
	return nil
}

// castFailureStep labels a failed cast-generation call in the failure log. It is a step name,
// not a game phase, because the call precedes any turn.
const castFailureStep = "cast_generation"

// generateCast asks for the whole village's speaking voices in one call so they can be made
// mutually distinct (independent per-player calls converge on the same trait), then records
// each privately. It never fails the run: any player missing or invalid in the response
// simply falls back to their configured personality. That fallback is silent — the players
// change register with no other trace — so every rejected attempt is written to the failure log.
func (r *Runner) generateCast(ctx context.Context) {
	if r.CharacterTemperature <= 0 {
		return
	}
	players := r.Game.Players()
	ids := make([]string, 0, len(players))
	roster := make([]string, 0, len(players))
	for _, player := range players {
		ids = append(ids, player.ID)
		roster = append(roster, player.ID+" ("+player.Name+")")
	}
	request := []model.Message{
		{Role: "system", Content: characterInstruction},
		{Role: "user", Content: fmt.Sprintf(characterRequestTemplate, strings.Join(roster, ", "))},
	}
	for attempt := 0; attempt <= r.MaxRetries; attempt++ {
		raw, err := r.completeCharacter(ctx, request)
		if err != nil {
			// A transport fault is recorded too: whether the call errored or was rejected, the
			// cast falls back silently and the register shift is otherwise unexplainable.
			r.ResponseLog.Record(FailureRecord{
				Phase:   castFailureStep,
				Attempt: attempt + 1,
				Error:   err.Error(),
			})
			continue
		}
		characters, err := model.ParseCharacters(raw, ids, characterLengthLimit)
		if err != nil {
			r.ResponseLog.Record(FailureRecord{
				Phase:    castFailureStep,
				Attempt:  attempt + 1,
				Error:    err.Error(),
				Response: raw,
			})
			continue
		}
		if missing := missingIDs(ids, characters); len(missing) > 0 {
			// A partial cast is accepted — the missing players keep their configured personality —
			// but a table mixing generated voices with console presets is a silent degradation, so
			// it is recorded in the same shape as a fault rather than left to read as randomness.
			r.ResponseLog.Record(FailureRecord{
				Phase:    castFailureStep,
				Attempt:  attempt + 1,
				Error:    fmt.Sprintf("partial cast: %d of %d voices returned (missing %s)", len(ids)-len(missing), len(ids), strings.Join(missing, ", ")),
				Response: raw,
			})
		}
		for id, character := range characters {
			r.characters[id] = character
			_ = r.Game.RecordCharacter(id, character)
		}
		return
	}
}

// missingIDs returns the expected ids a character response did not supply, in the given order, so
// a partial cast names exactly who fell back to their configured personality.
func missingIDs(expected []string, present map[string]string) []string {
	missing := make([]string, 0)
	for _, id := range expected {
		if _, ok := present[id]; !ok {
			missing = append(missing, id)
		}
	}
	return missing
}

func (r *Runner) completeCharacter(ctx context.Context, messages []model.Message) (string, error) {
	if client, ok := r.Client.(TemperatureCompletionClient); ok {
		return client.CompleteJSONWithTemperature(ctx, messages, r.CharacterTemperature)
	}
	return r.Client.CompleteJSON(ctx, messages)
}

// completeAction runs one player action at that player's resolved temperature, using the
// same optional capability as the character step and falling back to the client default
// (which is the run temperature) when the client cannot take a per-request temperature.
func (r *Runner) completeAction(ctx context.Context, messages []model.Message, temperature float64) (string, error) {
	if client, ok := r.Client.(TemperatureCompletionClient); ok {
		return client.CompleteJSONWithTemperature(ctx, messages, temperature)
	}
	return r.Client.CompleteJSON(ctx, messages)
}

func (r *Runner) runCurrentSpeaker(ctx context.Context) error {
	playerID := r.Game.CurrentSpeaker()
	if playerID == "" {
		return fmt.Errorf("phase %q has no current speaker", r.Game.Phase())
	}
	return r.requestAndApply(ctx, playerID)
}

func (r *Runner) runVote(ctx context.Context) error {
	for {
		for _, player := range r.Game.LivingPlayers() {
			if err := r.requestAndApply(ctx, player.ID); err != nil {
				return err
			}
		}
		resolution, err := r.Game.ResolveVote()
		if err != nil {
			return err
		}
		if !resolution.RequiresRevote {
			return nil
		}
	}
}

func (r *Runner) requestAndApply(ctx context.Context, playerID string) error {
	player, exists := r.Players[playerID]
	if !exists {
		return fmt.Errorf("missing configured player %q", playerID)
	}
	prompt, err := model.BuildActionPrompt(r.Game, model.PlayerPrompt{
		ID:          player.ID,
		Name:        player.Name,
		Personality: player.Personality,
		Character:   r.characters[player.ID],
	}, r.PromptStyle)
	if err != nil {
		return err
	}
	request := []model.Message{
		{Role: "system", Content: systemInstruction(r.PromptStyle)},
		{Role: "user", Content: prompt},
	}
	var lastErr error
	var correction error
	for attempt := 0; attempt <= r.MaxRetries; attempt++ {
		attemptRequest := request
		if correction != nil {
			attemptRequest = append(attemptRequest, model.Message{
				Role:    "user",
				Content: fmt.Sprintf("The moderator could not accept your previous response: %v. The newest situation and response instructions immediately above are the source of truth. Return one corrected JSON action that follows those instructions.", correction),
			})
			correction = nil
		}
		raw, err := r.completeAction(ctx, attemptRequest, r.playerTemperatures[playerID])
		if err == nil {
			var action game.Action
			action, err = model.ParseAction(raw)
			if err == nil {
				err = r.Game.Apply(playerID, action)
			}
			if err != nil {
				// The raw text is the only record of what the model actually said; keep it so a
				// failed run can be diagnosed after the container is gone.
				r.ResponseLog.Record(FailureRecord{
					Phase:    string(r.Game.Phase()),
					Player:   playerID,
					Attempt:  attempt + 1,
					Error:    err.Error(),
					Response: raw,
				})
				correction = err
			}
		}
		if err == nil {
			return nil
		}
		lastErr = err
	}
	return fmt.Errorf("player %q failed after %d attempts: %w", playerID, r.MaxRetries+1, lastErr)
}

func (r *Runner) playerWithRole(role game.Role) string {
	for _, player := range r.Game.LivingPlayers() {
		actual, _ := r.Game.RoleFor(player.ID)
		if actual == role {
			return player.ID
		}
	}
	return ""
}

func (r *Runner) playersWithRole(role game.Role) []string {
	ids := make([]string, 0)
	for _, player := range r.Game.LivingPlayers() {
		actual, _ := r.Game.RoleFor(player.ID)
		if actual == role {
			ids = append(ids, player.ID)
		}
	}
	return ids
}

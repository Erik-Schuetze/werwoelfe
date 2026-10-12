package experiment

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/eschuetze/werwoelfe/internal/game"
	"github.com/eschuetze/werwoelfe/internal/model"
)

// titleInstruction is the system message for the one off-gameplay naming call, mirroring
// characterInstruction: it fixes the role and forbids the failure mode. The namer is shown
// the whole run — outcome included — by explicit choice, so the prohibition on spoilers is
// the whole point of this message, and the gate below is what actually enforces it.
const titleInstruction = "You title the story of one village from a completed game of The Werewolves of Millers Hollow. You are not playing anyone and you never address the players. Your single job is a short, playful, spoiler-free chapter heading for this village's tale. The record you are given is the whole run, but the title must give nothing away: never name the winner or a side, never state or imply which side prevailed, never say whether the village's suspicions were right or wrong, never label any player as good or bad, and never refer to the game having ended. Return only the requested JSON action."

// titleRequestTemplate is formatted with the run's readable public transcript.
const titleRequestTemplate = `Below is the full public record of one completed game, earliest first. Read it, then give this village's story its title.

%s

Title rules:
- One short chapter-heading-style title for this village's story — evocative and playful, not a summary of what happened.
- In the register of "A badge and a bluff".
- State no number and no count, of players or of nights. The example register this replaces named
  "eight voices, three nights", and a title came back claiming twelve voices for a table of eight —
  a number invented from the example rather than counted.
- At most 60 characters. No quotation marks. No trailing period.
- Absolutely no spoilers: do not name the winner or any side; do not state or imply which side prevailed; do not say or hint whether the village's suspicions were correct; do not mark any player as good, bad, guilty or innocent; do not hint that the game has ended.
- Do not name any player who was eliminated, and do not refer to any elimination.

Reply with {"action":"title","title":"..."}.`

// titleLengthLimit is the most a run title may be, in runes, matching the prompt's cap.
const titleLengthLimit = 60

// titleOutcomePatterns hold, one entry per wording family, the inflections that would
// reveal or hint at how a run ended. Each entry is a controlled suffix set for a single
// stem rather than a blanket \w*: this catches the obvious inflections of its own list
// ("winners", "executions", "survives") while still refusing an unrelated longer word
// ("wonder", "weekend"). Every entry sits inside one \b(?:...)\b alternation, so the whole
// match stays anchored to word boundaries. Keep this one flat, commented list so it stays
// auditable and cheap to extend.
//
// Deliberately absent: the bare token "over". As a whole word it is far more often benign
// ("Over the Table", "All Over the Village") than a spoiler, and a controlled suffix set
// cannot separate the two, so the recall is surrendered rather than reject good titles.
var titleOutcomePatterns = []string{
	`wins?`,                           // win, wins
	`winner(?:s)?`,                    // winner, winners
	`winning`,                         // winning
	`won`,                             // won (kept exact: "won" must not match "wonder")
	`victory`,                         // victory
	`victories`,                       // victories
	`victorious`,                      // victorious
	`lose`,                            // lose
	`loses`,                           // loses
	`lost`,                            // lost
	`losing`,                          // losing
	`loser(?:s)?`,                     // loser, losers
	`defeat(?:s|ed|ing)?`,             // defeat, defeats, defeated, defeating
	`triumph(?:s|ed|ing|ant)?`,        // triumph, triumphs, triumphed, triumphant
	`prevail(?:s|ed|ing)?`,            // prevail, prevails, prevailed, prevailing
	`unmask(?:s|ed|ing)?`,             // unmask, unmasks, unmasked, unmasking
	`surviv(?:e|es|ed|ing|or(?:s)?)`,  // survive(s/d/ing), survivor(s)
	`escape(?:s|d)`,                   // escape, escapes, escaped
	`expos(?:e|es|ed|ing)`,            // expose, exposes, exposed, exposing
	`guilt(?:y)?`,                     // guilt, guilty
	`execut(?:e|es|ed|ing|ion(?:s)?)`, // execute(s/d/ing), execution(s)
	`innocent`,                        // innocent
	`caught`,                          // caught
	`hanged`,                          // hanged
	`lynched`,                         // lynched
	`end(?:s|ed|ing)?`,                // end(s/ed/ing); the boundary keeps "weekend" safe
	`final`,                           // final
}

// titleOutcomePattern matches any of the families above as a whole word, case-insensitively.
// The word boundaries keep "won" out of "wonder" and "end" out of "weekend"; the per-family
// suffix sets keep "winners" and "executions" in.
var titleOutcomePattern = regexp.MustCompile(`(?i)\b(?:` + strings.Join(titleOutcomePatterns, "|") + `)\b`)

// generateTitle makes the single off-gameplay naming call, mirroring generateCast: one
// request at its own temperature, strict JSON parsed from the reply, and best-effort
// throughout — any failure leaves the deterministic fallback in place and never fails the
// run. It is called once after the game ends, before the result artifact is written.
func (r *Runner) generateTitle(ctx context.Context) {
	// The fallback is always set first: it needs no model, names nobody and cannot leak a
	// result, so it is what remains if the call is disabled, fails, or is rejected twice.
	r.title = fallbackTitle(len(r.Game.Players()), r.Game.Day())
	if r.TitleTemperature <= 0 {
		return
	}
	request := []model.Message{
		{Role: "system", Content: titleInstruction},
		{Role: "user", Content: fmt.Sprintf(titleRequestTemplate, titleTranscript(r.Game.HistoryFor("")))},
	}
	eliminated := r.eliminatedNames()
	for attempt := 0; attempt <= r.MaxRetries; attempt++ {
		raw, err := r.completeTitle(ctx, request)
		if err != nil {
			continue
		}
		title, err := model.ParseTitle(raw)
		if err != nil {
			continue
		}
		if titleSpoiler(title, eliminated, titleLengthLimit) != "" {
			continue
		}
		r.title = title
		return
	}
}

// completeTitle runs the naming request at the title temperature, using the same optional
// per-request capability as the other off-gameplay and action calls.
func (r *Runner) completeTitle(ctx context.Context, messages []model.Message) (string, error) {
	if client, ok := r.Client.(TemperatureCompletionClient); ok {
		return client.CompleteJSONWithTemperature(ctx, messages, r.TitleTemperature)
	}
	return r.Client.CompleteJSON(ctx, messages)
}

// titleTranscript renders the run's public history as readable lines, one event per line.
// The event messages are already the readable form — "Name: message" for speeches and
// plain sentences for votes, tallies, eliminations and the final result — so the namer sees
// the whole story without the runner re-deriving any of it.
func titleTranscript(events []game.Event) string {
	lines := make([]string, 0, len(events))
	for _, event := range events {
		if line := strings.TrimSpace(event.Message); line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

// eliminatedNames is the set of players the village lost — eaten or exiled — read from the
// run's own public events. The gate refuses a title that names any of them: naming the
// fallen would reveal that they fell.
func (r *Runner) eliminatedNames() []string {
	names := make([]string, 0)
	seen := make(map[string]bool)
	for _, event := range r.Game.HistoryFor("") {
		if event.Kind != "player_removed" || event.PlayerID == "" {
			continue
		}
		name := r.Game.NameOf(event.PlayerID)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// titleSpoiler reports why a title is unsafe to show, or "" when it passes the gate. This
// is the deterministic safety property behind the naming call: the namer saw the whole run,
// so its suggestion is rejected outright if it would leak how the run ended.
func titleSpoiler(title string, eliminated []string, maxLength int) string {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return "title is empty"
	}
	if utf8.RuneCountInString(trimmed) > maxLength {
		return fmt.Sprintf("title exceeds %d characters", maxLength)
	}
	if match := titleOutcomePattern.FindString(trimmed); match != "" {
		return fmt.Sprintf("title contains outcome token %q", match)
	}
	for _, name := range eliminated {
		if name != "" && mentionsWord(trimmed, name) {
			return fmt.Sprintf("title names eliminated player %q", name)
		}
	}
	return ""
}

// mentionsWord reports whether text contains word as a whole word, case-insensitively. The
// word is quoted so a player name cannot smuggle in a regex metacharacter.
func mentionsWord(text, word string) bool {
	return regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(word) + `\b`).MatchString(text)
}

// fallbackTitle builds a spoiler-free title from the only facts that cannot give the run
// away: how many players sat down and how many nights passed. It names nobody, mentions no
// elimination, says nothing about who prevailed, and excludes the outcome tokens by
// construction, in the register of "Millers Hollow — eight voices, three nights".
func fallbackTitle(playerCount, nights int) string {
	return fmt.Sprintf("Millers Hollow — %s, %s", voiceCount(playerCount), nightCount(nights))
}

func voiceCount(count int) string {
	if count == 1 {
		return numberWord(count) + " voice"
	}
	return numberWord(count) + " voices"
}

func nightCount(count int) string {
	if count == 1 {
		return numberWord(count) + " night"
	}
	return numberWord(count) + " nights"
}

// numberWord spells small counts as words, falling back to digits for anything larger.
// None of these words collides with an outcome token.
func numberWord(value int) string {
	words := map[int]string{
		0: "no", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
		6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
		11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen",
		16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen", 20: "twenty",
	}
	if word, ok := words[value]; ok {
		return word
	}
	return strconv.Itoa(value)
}

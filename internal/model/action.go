package model

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/eschuetze/werwoelfe/internal/game"
)

// ParseAction decodes one model action response. The contract is tolerant of *shape* and
// strict about *content*. A reasoning model readily adds a field the schema never asked for
// ("reasoning", "reasoning_note", "action"), so unknown fields are ignored rather than
// punished, "action" is the requested discriminator and "type" is accepted as a fallback for
// an in-flight or replayed caller, and private reasoning filed under a different key is
// recovered as the thought instead of being discarded. Genuine malformations are still
// rejected: a non-empty discriminator is required and a trailing or second JSON value is an
// error. Whether the action is legal for the current phase is decided later, by Game.Apply.
func ParseAction(raw string) (game.Action, error) {
	var payload struct {
		Type    string `json:"type"`
		Action  string `json:"action"`
		Target  string `json:"target"`
		Message string `json:"message"`
		Thought string `json:"thought"`
		// Reasoning-ish aliases a model may use instead of "thought", tried in the order below.
		Reasoning     string `json:"reasoning"`
		ReasoningNote string `json:"reasoning_note"`
		Thinking      string `json:"thinking"`
		Analysis      string `json:"analysis"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	if err := decoder.Decode(&payload); err != nil {
		return game.Action{}, fmt.Errorf("parse action JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return game.Action{}, fmt.Errorf("action response contains multiple JSON values")
	}
	// "action" is the requested key; "type" is accepted as a fallback for any in-flight or
	// replayed caller, and "action" wins when both appear.
	actionType := strings.TrimSpace(payload.Action)
	if actionType == "" {
		actionType = strings.TrimSpace(payload.Type)
	}
	// Cheap hardening: a response that echoes the request's mode key/value pair (JSON mode is
	// requested as response_format {"type":"json_object"}) must be read as a *missing*
	// discriminator, not as an action named "json_object". The rename to "action" is what
	// removes the collision; this is belt-and-braces in case the request shape changes again.
	// Surfacing it as a missing action lets the corrective retry name the real fault instead
	// of reporting an illegal action. Unreachable while the request no longer says "type".
	if actionType == "json_object" || actionType == "json" {
		actionType = ""
	}
	if actionType == "" {
		return game.Action{}, fmt.Errorf("action type is required")
	}
	action := game.Action{
		Type:    actionType,
		Target:  strings.TrimSpace(payload.Target),
		Message: strings.TrimSpace(payload.Message),
		Thought: strings.TrimSpace(payload.Thought),
	}
	// The model did the reasoning either way; when it filed the private read under a different
	// key, adopt it rather than throwing away the most valuable part of the response.
	if action.Thought == "" {
		action.Thought = firstReasoning(
			payload.Reasoning,
			payload.ReasoningNote,
			payload.Thinking,
			payload.Analysis,
		)
	}
	return action, nil
}

// firstReasoning returns the first non-empty value, trimmed. The caller passes the candidate
// keys in preference order, so the first field the model happened to use wins.
func firstReasoning(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// ParseTitle extracts the one off-gameplay run title shaped
// {"action":"title","title":"..."}. It keeps a strict contract of its own: unknown fields are
// rejected and the discriminator must be present and exactly "title". "action" is the
// requested key and "type" is accepted as a fallback for an in-flight or replayed caller; a
// discriminator that echoes the request's JSON-mode value is read as missing. The spoiler
// gate is a separate, deterministic step the caller applies to the parsed title.
func ParseTitle(raw string) (string, error) {
	var payload struct {
		Action string `json:"action"`
		Type   string `json:"type"`
		Title  string `json:"title"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return "", fmt.Errorf("parse title JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return "", fmt.Errorf("title response contains multiple JSON values")
	}
	kind := strings.TrimSpace(payload.Action)
	if kind == "" {
		kind = strings.TrimSpace(payload.Type)
	}
	// See ParseAction: a leaked JSON-mode value is a missing discriminator, not a title.
	if kind == "json_object" || kind == "json" {
		kind = ""
	}
	if kind != "title" {
		return "", fmt.Errorf("title response type = %q, want %q", kind, "title")
	}
	title := strings.TrimSpace(payload.Title)
	if title == "" {
		return "", fmt.Errorf("title is required")
	}
	return title, nil
}

// ParseCharacters extracts a whole-cast character response shaped
// {"action":"characters","characters":[{"id":"p1","message":"..."}]}. "action" is the
// requested discriminator and "type" is accepted as a fallback for an in-flight or replayed
// caller; a discriminator that echoes the request's JSON-mode value is read as missing.
// Unknown or duplicate ids are an error; empty or over-long descriptions are dropped so a
// partial batch still yields useful characters and the caller can fall back only for the
// missing players.
func ParseCharacters(raw string, expectedIDs []string, maxLength int) (map[string]string, error) {
	var payload struct {
		Action     string `json:"action"`
		Type       string `json:"type"`
		Characters []struct {
			ID      string `json:"id"`
			Message string `json:"message"`
		} `json:"characters"`
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("parse characters JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("characters response contains multiple JSON values")
	}
	kind := strings.TrimSpace(payload.Action)
	if kind == "" {
		kind = strings.TrimSpace(payload.Type)
	}
	// See ParseAction: a leaked JSON-mode value is a missing discriminator, not a batch.
	if kind == "json_object" || kind == "json" {
		kind = ""
	}
	if kind != "characters" {
		return nil, fmt.Errorf("characters response type = %q, want %q", kind, "characters")
	}
	if len(payload.Characters) == 0 {
		return nil, fmt.Errorf("characters response is empty")
	}
	expected := make(map[string]bool, len(expectedIDs))
	for _, id := range expectedIDs {
		expected[id] = true
	}
	characters := make(map[string]string, len(payload.Characters))
	for _, entry := range payload.Characters {
		id := strings.TrimSpace(entry.ID)
		message := strings.TrimSpace(entry.Message)
		if !expected[id] {
			return nil, fmt.Errorf("unknown character id %q", id)
		}
		if _, exists := characters[id]; exists {
			return nil, fmt.Errorf("duplicate character id %q", id)
		}
		if message == "" || utf8.RuneCountInString(message) > maxLength {
			continue
		}
		characters[id] = message
	}
	return characters, nil
}

package config

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/eschuetze/werwoelfe/internal/game"
)

type Player struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Personality string `json:"personality"`
	// Temperature is an optional per-player override. It is a pointer so an explicit
	// 0 (fully deterministic) is distinguishable from "unset, inherit the run default".
	Temperature *float64 `json:"temperature,omitempty"`
}

type Model struct {
	BaseURL              string  `json:"base_url"`
	Name                 string  `json:"name"`
	MaxRetries           int     `json:"max_retries"`
	Temperature          float64 `json:"temperature"`
	CharacterTemperature float64 `json:"character_temperature"`
	TitleTemperature     float64 `json:"title_temperature"`
	PromptStyle          string  `json:"prompt_style"`
}

type Config struct {
	Players []Player    `json:"players"`
	Roles   []game.Role `json:"roles,omitempty"`
	Model   Model       `json:"model"`
}

// PromptStyle selects which prompt arm the runner assembles. Classic preserves the
// original wording; social is the rewritten variant. Both are runnable from one build.
const (
	PromptStyleClassic = "classic"
	PromptStyleSocial  = "social"
)

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	var specified struct {
		Model struct {
			MaxRetries           *int     `json:"max_retries"`
			Temperature          *float64 `json:"temperature"`
			CharacterTemperature *float64 `json:"character_temperature"`
			TitleTemperature     *float64 `json:"title_temperature"`
			PromptStyle          *string  `json:"prompt_style"`
		} `json:"model"`
	}
	if err := json.Unmarshal(data, &specified); err != nil {
		return Config{}, fmt.Errorf("inspect config defaults: %w", err)
	}
	if len(cfg.Players) < 8 || len(cfg.Players) > 18 {
		return Config{}, fmt.Errorf("config requires 8 to 18 players, got %d", len(cfg.Players))
	}
	if cfg.Model.BaseURL == "" {
		cfg.Model.BaseURL = "https://api.deepseek.com"
	}
	if cfg.Model.Name == "" {
		cfg.Model.Name = "deepseek-flash"
	}
	if specified.Model.MaxRetries == nil {
		cfg.Model.MaxRetries = 2
	}
	if cfg.Model.MaxRetries < 0 {
		return Config{}, fmt.Errorf("max_retries cannot be negative")
	}
	if specified.Model.Temperature == nil {
		cfg.Model.Temperature = 1.0
	}
	if cfg.Model.Temperature < 0 || cfg.Model.Temperature > 2 {
		return Config{}, fmt.Errorf("temperature must be between 0 and 2")
	}
	if specified.Model.CharacterTemperature == nil {
		cfg.Model.CharacterTemperature = 1.2
	}
	if cfg.Model.CharacterTemperature < 0 || cfg.Model.CharacterTemperature > 2 {
		return Config{}, fmt.Errorf("character_temperature must be between 0 and 2")
	}
	if specified.Model.TitleTemperature == nil {
		cfg.Model.TitleTemperature = 1.2
	}
	if cfg.Model.TitleTemperature < 0 || cfg.Model.TitleTemperature > 2 {
		return Config{}, fmt.Errorf("title_temperature must be between 0 and 2")
	}
	if specified.Model.PromptStyle == nil {
		cfg.Model.PromptStyle = PromptStyleClassic
	}
	if cfg.Model.PromptStyle != PromptStyleClassic && cfg.Model.PromptStyle != PromptStyleSocial {
		return Config{}, fmt.Errorf("prompt_style must be %q or %q", PromptStyleClassic, PromptStyleSocial)
	}
	if len(cfg.Roles) == 0 {
		cfg.Roles = game.RecommendedRoles(len(cfg.Players))
	}
	if err := game.ValidateRoles(cfg.Roles, len(cfg.Players)); err != nil {
		return Config{}, fmt.Errorf("invalid roles: %w", err)
	}
	ids := make(map[string]struct{}, len(cfg.Players))
	for _, player := range cfg.Players {
		if player.ID == "" || player.Name == "" {
			return Config{}, fmt.Errorf("each player needs a non-empty id and name")
		}
		if _, exists := ids[player.ID]; exists {
			return Config{}, fmt.Errorf("duplicate player id %q", player.ID)
		}
		if player.Temperature != nil && (*player.Temperature < 0 || *player.Temperature > 2) {
			return Config{}, fmt.Errorf("player %q temperature must be between 0 and 2", player.ID)
		}
		ids[player.ID] = struct{}{}
	}
	return cfg, nil
}

package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadModelDefaultsAndOverrides(t *testing.T) {
	players := make([]Player, 8)
	for index := range players {
		players[index] = Player{ID: string(rune('a' + index)), Name: "Player"}
	}
	tests := []struct {
		name        string
		model       map[string]any
		wantRetries int
		wantModel   string
		wantTemp    float64
	}{
		{name: "omitted", model: map[string]any{}, wantRetries: 2, wantModel: "deepseek-flash", wantTemp: 1.0},
		{name: "zero retries and temperature", model: map[string]any{"max_retries": 0, "temperature": 0}, wantRetries: 0, wantModel: "deepseek-flash", wantTemp: 0},
		{name: "positive retries and temperature", model: map[string]any{"max_retries": 3, "temperature": 1.5, "name": "custom-model"}, wantRetries: 3, wantModel: "custom-model", wantTemp: 1.5},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(struct {
				Players []Player       `json:"players"`
				Model   map[string]any `json:"model"`
			}{Players: players, Model: test.model})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}

			cfg, err := Load(path)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Model.MaxRetries != test.wantRetries {
				t.Fatalf("max retries = %d, want %d", cfg.Model.MaxRetries, test.wantRetries)
			}
			if cfg.Model.Name != test.wantModel {
				t.Fatalf("model name = %q, want %q", cfg.Model.Name, test.wantModel)
			}
			if cfg.Model.Temperature != test.wantTemp {
				t.Fatalf("temperature = %v, want %v", cfg.Model.Temperature, test.wantTemp)
			}
		})
	}
}

func TestLoadRejectsOutOfRangeTemperature(t *testing.T) {
	players := make([]Player, 8)
	for index := range players {
		players[index] = Player{ID: string(rune('a' + index)), Name: "Player"}
	}
	for _, test := range []struct {
		name        string
		temperature float64
	}{
		{name: "below minimum", temperature: -0.1},
		{name: "above maximum", temperature: 2.1},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(struct {
				Players []Player       `json:"players"`
				Model   map[string]any `json:"model"`
			}{Players: players, Model: map[string]any{"temperature": test.temperature}})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatalf("temperature %v was accepted", test.temperature)
			}
		})
	}
}

func TestLoadPerPlayerTemperatureKeepsExplicitZero(t *testing.T) {
	players := `[
		{"id":"p1","name":"One","temperature":0},
		{"id":"p2","name":"Two"},
		{"id":"p3","name":"Three","temperature":1.7},
		{"id":"p4","name":"Four"},{"id":"p5","name":"Five"},{"id":"p6","name":"Six"},
		{"id":"p7","name":"Seven"},{"id":"p8","name":"Eight"}
	]`
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"players":`+players+`,"model":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Players[0].Temperature == nil || *cfg.Players[0].Temperature != 0 {
		t.Fatalf("explicit 0 was not preserved: %v", cfg.Players[0].Temperature)
	}
	if cfg.Players[1].Temperature != nil {
		t.Fatalf("unset temperature should stay nil, got %v", *cfg.Players[1].Temperature)
	}
	if cfg.Players[2].Temperature == nil || *cfg.Players[2].Temperature != 1.7 {
		t.Fatalf("explicit 1.7 was not preserved: %v", cfg.Players[2].Temperature)
	}
}

func TestLoadRejectsOutOfRangePlayerTemperature(t *testing.T) {
	for _, temperature := range []float64{-0.1, 2.1} {
		players := fmt.Sprintf(`[{"id":"p1","name":"One","temperature":%v},
			{"id":"p2","name":"Two"},{"id":"p3","name":"Three"},{"id":"p4","name":"Four"},
			{"id":"p5","name":"Five"},{"id":"p6","name":"Six"},{"id":"p7","name":"Seven"},{"id":"p8","name":"Eight"}]`, temperature)
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(`{"players":`+players+`,"model":{}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatalf("player temperature %v was accepted", temperature)
		}
	}
}

func TestLoadPromptStyleDefaultsAndValidates(t *testing.T) {
	players := make([]Player, 8)
	for index := range players {
		players[index] = Player{ID: string(rune('a' + index)), Name: "Player"}
	}
	for _, test := range []struct {
		name    string
		model   map[string]any
		want    string
		wantErr bool
	}{
		{name: "omitted defaults to classic", model: map[string]any{}, want: PromptStyleClassic},
		{name: "social accepted", model: map[string]any{"prompt_style": "social"}, want: PromptStyleSocial},
		{name: "classic accepted", model: map[string]any{"prompt_style": "classic"}, want: PromptStyleClassic},
		{name: "unknown rejected", model: map[string]any{"prompt_style": "radical"}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(struct {
				Players []Player       `json:"players"`
				Model   map[string]any `json:"model"`
			}{Players: players, Model: test.model})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if test.wantErr {
				if err == nil {
					t.Fatal("unknown prompt_style was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Model.PromptStyle != test.want {
				t.Fatalf("prompt style = %q, want %q", cfg.Model.PromptStyle, test.want)
			}
		})
	}
}

func TestLoadTitleTemperatureDefaultsAndOverrides(t *testing.T) {
	players := make([]Player, 8)
	for index := range players {
		players[index] = Player{ID: string(rune('a' + index)), Name: "Player"}
	}
	for _, test := range []struct {
		name    string
		model   map[string]any
		want    float64
		wantErr bool
	}{
		{name: "omitted defaults to 1.2", model: map[string]any{}, want: 1.2},
		{name: "explicit value", model: map[string]any{"title_temperature": 1.9}, want: 1.9},
		{name: "zero disables", model: map[string]any{"title_temperature": 0}, want: 0},
		{name: "out of range", model: map[string]any{"title_temperature": 2.1}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(struct {
				Players []Player       `json:"players"`
				Model   map[string]any `json:"model"`
			}{Players: players, Model: test.model})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if test.wantErr {
				if err == nil {
					t.Fatal("out-of-range title_temperature was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Model.TitleTemperature != test.want {
				t.Fatalf("title temperature = %v, want %v", cfg.Model.TitleTemperature, test.want)
			}
		})
	}
}

func TestLoadCharacterTemperatureDefaultsAndOverrides(t *testing.T) {
	players := make([]Player, 8)
	for index := range players {
		players[index] = Player{ID: string(rune('a' + index)), Name: "Player"}
	}
	for _, test := range []struct {
		name    string
		model   map[string]any
		want    float64
		wantErr bool
	}{
		{name: "omitted defaults to 1.2", model: map[string]any{}, want: 1.2},
		{name: "explicit value", model: map[string]any{"character_temperature": 1.9}, want: 1.9},
		{name: "zero disables", model: map[string]any{"character_temperature": 0}, want: 0},
		{name: "out of range", model: map[string]any{"character_temperature": 2.1}, wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(struct {
				Players []Player       `json:"players"`
				Model   map[string]any `json:"model"`
			}{Players: players, Model: test.model})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(path)
			if test.wantErr {
				if err == nil {
					t.Fatal("out-of-range character_temperature was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Model.CharacterTemperature != test.want {
				t.Fatalf("character temperature = %v, want %v", cfg.Model.CharacterTemperature, test.want)
			}
		})
	}
}

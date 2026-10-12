package experiment

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/eschuetze/werwoelfe/internal/config"
	"github.com/eschuetze/werwoelfe/internal/game"
)

// Result is the sanitized, durable record of a completed game.
type Result struct {
	SchemaVersion        int            `json:"schema_version"`
	Seed                 uint64         `json:"seed"`
	StartedAt            time.Time      `json:"started_at"`
	FinishedAt           time.Time      `json:"finished_at"`
	DurationMilliseconds int64          `json:"duration_milliseconds"`
	Winner               string         `json:"winner"`
	Title                string         `json:"title"`
	Model                ResultModel    `json:"model"`
	MaxRetries           int            `json:"max_retries"`
	Players              []ResultPlayer `json:"players"`
	PublicEventHistory   []game.Event   `json:"public_event_history"`
}

type ResultModel struct {
	BaseURL     string  `json:"base_url"`
	Name        string  `json:"name"`
	Temperature float64 `json:"temperature"`
}

type ResultPlayer struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Role  game.Role `json:"role"`
	Alive bool      `json:"alive"`
}

func NewResult(
	runner *Runner,
	cfg config.Config,
	seed uint64,
	startedAt time.Time,
	finishedAt time.Time,
) (Result, error) {
	if runner == nil || runner.Game == nil {
		return Result{}, fmt.Errorf("cannot create a result without a completed game")
	}
	if runner.Game.Phase() != game.Finished {
		return Result{}, fmt.Errorf("cannot create a result before the game finishes")
	}

	players := make([]ResultPlayer, 0, len(runner.Game.Players()))
	for _, player := range runner.Game.Players() {
		role, exists := runner.Game.RoleFor(player.ID)
		if !exists {
			return Result{}, fmt.Errorf("missing role for player %q", player.ID)
		}
		players = append(players, ResultPlayer{
			ID: player.ID, Name: player.Name, Role: role, Alive: runner.Game.IsAlive(player.ID),
		})
	}

	return Result{
		SchemaVersion:        1,
		Seed:                 seed,
		StartedAt:            startedAt.UTC(),
		FinishedAt:           finishedAt.UTC(),
		DurationMilliseconds: finishedAt.Sub(startedAt).Milliseconds(),
		Winner:               runner.Game.Winner(),
		Title:                runner.Title(),
		Model:                ResultModel{BaseURL: cfg.Model.BaseURL, Name: cfg.Model.Name, Temperature: cfg.Model.Temperature},
		MaxRetries:           runner.MaxRetries,
		Players:              players,
		PublicEventHistory:   runner.Game.HistoryFor(""),
	}, nil
}

func WriteResult(path string, result Result) error {
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal game result: %w", err)
	}
	data = append(data, '\n')

	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("create result file: %w", err)
	}
	temporaryPath := file.Name()
	defer os.Remove(temporaryPath)

	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return fmt.Errorf("restrict result file permissions: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fmt.Errorf("write game result: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return fmt.Errorf("sync game result: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close game result: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish game result: %w", err)
	}
	return nil
}

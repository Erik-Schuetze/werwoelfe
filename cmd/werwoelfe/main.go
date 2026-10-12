package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"time"

	"github.com/eschuetze/werwoelfe/internal/config"
	"github.com/eschuetze/werwoelfe/internal/experiment"
	"github.com/eschuetze/werwoelfe/internal/model"
)

func main() {
	configPath := flag.String("config", "config.json", "path to the non-secret game configuration")
	timeout := flag.Duration("timeout", 15*time.Minute, "maximum duration for one game; zero disables the timeout")
	seed := flag.Uint64("seed", 0, "optional deterministic random seed; zero uses a nondeterministic seed")
	resultPath := flag.String("result", "game-result.json", "path for the sanitized completed-game result; empty disables writing it")
	eventPath := flag.String("events", "", "optional path for append-only operator event records")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		exitf("configuration error: %v", err)
	}
	client, err := model.NewDeepSeek(cfg.Model.BaseURL, os.Getenv("DEEPSEEK_API_KEY"), cfg.Model.Name, cfg.Model.Temperature, nil)
	if err != nil {
		exitf("DeepSeek configuration error: %v", err)
	}
	actualSeed := *seed
	if actualSeed == 0 {
		actualSeed = uint64(time.Now().UnixNano())
	}
	source := rand.NewPCG(actualSeed, actualSeed^0x9e3779b97f4a7c15)
	runner, err := experiment.NewRunner(cfg, client, rand.New(source))
	if err != nil {
		exitf("game setup error: %v", err)
	}
	// Persist any raw response that fails to parse or validate, and any failed cast-generation
	// call, next to the event stream so it lands in the mounted output directory and outlives the
	// container. Writes are unbuffered, so the log survives the exitf paths below; it is
	// best-effort and never fails a run.
	failureLog := experiment.NewResponseLog(*eventPath)
	defer func() { _ = failureLog.Close() }()
	runner.ResponseLog = failureLog
	var stream *experiment.EventStream
	if *eventPath != "" {
		stream, err = experiment.NewEventStream(*eventPath)
		if err != nil {
			exitf("open event stream: %v", err)
		}
		runner.Game.SetEventObserver(stream.WriteEvent)
	}
	var ctx context.Context = context.Background()
	cancel := func() {}
	if *timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, *timeout)
	}
	defer cancel()
	startedAt := time.Now()
	if err := runner.Run(ctx); err != nil {
		if stream != nil {
			stream.WriteFailure(err)
			if closeErr := stream.Close(); closeErr != nil {
				exitf("close event stream: %v", closeErr)
			}
		}
		exitf("game failed: %v", err)
	}
	finishedAt := time.Now()
	if *resultPath != "" || stream != nil {
		result, err := experiment.NewResult(runner, cfg, actualSeed, startedAt, finishedAt)
		if err != nil {
			if stream != nil {
				stream.WriteFailure(err)
				_ = stream.Close()
			}
			exitf("build game result: %v", err)
		}
		if *resultPath != "" {
			if err := experiment.WriteResult(*resultPath, result); err != nil {
				if stream != nil {
					stream.WriteFailure(err)
					_ = stream.Close()
				}
				exitf("write game result: %v", err)
			}
		}
		if stream != nil {
			stream.WriteResult(result)
		}
	}
	if stream != nil {
		if err := stream.Close(); err != nil {
			exitf("close event stream: %v", err)
		}
	}
	for _, event := range runner.Game.HistoryFor("") {
		fmt.Printf("[%03d] %s\n", event.Sequence, event.Message)
	}
	fmt.Printf("Winner: %s\n", runner.Game.Winner())
	if *resultPath != "" {
		fmt.Printf("Result: %s\n", *resultPath)
	}
}

func exitf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

package experiment

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/eschuetze/werwoelfe/internal/game"
)

type StreamRecord struct {
	SchemaVersion int         `json:"schema_version"`
	Type          string      `json:"type"`
	Event         *game.Event `json:"event,omitempty"`
	Result        *Result     `json:"result,omitempty"`
	Error         string      `json:"error,omitempty"`
}

type EventStream struct {
	file   *os.File
	writer *bufio.Writer
	mu     sync.Mutex
	err    error
}

func NewEventStream(path string) (*EventStream, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open event stream: %w", err)
	}
	return &EventStream{file: file, writer: bufio.NewWriter(file)}, nil
}

func (s *EventStream) WriteEvent(event game.Event) {
	s.write(StreamRecord{SchemaVersion: 1, Type: "event", Event: &event})
}

func (s *EventStream) WriteResult(result Result) {
	s.write(StreamRecord{SchemaVersion: 1, Type: "result", Result: &result})
}

func (s *EventStream) WriteFailure(err error) {
	if err == nil {
		return
	}
	s.write(StreamRecord{SchemaVersion: 1, Type: "failure", Error: err.Error()})
}

func (s *EventStream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return s.err
	}
	if s.err == nil {
		if err := s.writer.Flush(); err != nil {
			s.err = fmt.Errorf("flush event stream: %w", err)
		} else if err := s.file.Sync(); err != nil {
			s.err = fmt.Errorf("sync event stream: %w", err)
		}
	}
	if err := s.file.Close(); s.err == nil && err != nil {
		s.err = fmt.Errorf("close event stream: %w", err)
	}
	s.file = nil
	return s.err
}

func (s *EventStream) write(record StreamRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil || s.file == nil {
		return
	}
	data, err := json.Marshal(record)
	if err == nil {
		_, err = s.writer.Write(append(data, '\n'))
	}
	if err == nil {
		err = s.writer.Flush()
	}
	if err == nil {
		err = s.file.Sync()
	}
	if err != nil {
		s.err = fmt.Errorf("write event stream: %w", err)
	}
}

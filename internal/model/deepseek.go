package model

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Client struct {
	baseURL     string
	apiKey      string
	model       string
	temperature float64
	http        *http.Client
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Thinking struct {
		Type string `json:"type"`
	} `json:"thinking"`
	Temperature    float64 `json:"temperature"`
	ResponseFormat struct {
		Type string `json:"type"`
	} `json:"response_format"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func NewDeepSeek(baseURL, apiKey, model string, temperature float64, client *http.Client) (*Client, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("DEEPSEEK_API_KEY is required")
	}
	if temperature < 0 || temperature > 2 {
		return nil, fmt.Errorf("temperature must be between 0 and 2")
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"), apiKey: apiKey, model: model, temperature: temperature, http: client,
	}, nil
}

func (c *Client) CompleteJSON(ctx context.Context, messages []Message) (string, error) {
	return c.CompleteJSONWithTemperature(ctx, messages, c.temperature)
}

// CompleteJSONWithTemperature behaves like CompleteJSON but uses the given
// temperature for this single request instead of the client's configured value.
func (c *Client) CompleteJSONWithTemperature(ctx context.Context, messages []Message, temperature float64) (string, error) {
	request := chatRequest{
		Model:    c.model,
		Messages: messages,
		Thinking: struct {
			Type string `json:"type"`
		}{Type: "disabled"},
		Temperature: temperature,
	}
	request.ResponseFormat.Type = "json_object"
	body, err := json.Marshal(request)
	if err != nil {
		return "", fmt.Errorf("marshal DeepSeek request: %w", err)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create DeepSeek request: %w", err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(httpRequest)
	if err != nil {
		return "", fmt.Errorf("request DeepSeek completion: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read DeepSeek response: %w", err)
	}
	var parsed chatResponse
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return "", fmt.Errorf("parse DeepSeek response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if parsed.Error != nil {
			return "", fmt.Errorf("DeepSeek returned HTTP %d: %s", response.StatusCode, parsed.Error.Message)
		}
		return "", fmt.Errorf("DeepSeek returned HTTP %d", response.StatusCode)
	}
	if parsed.Error != nil {
		return "", fmt.Errorf("DeepSeek error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) != 1 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("DeepSeek returned no completion")
	}
	return parsed.Choices[0].Message.Content, nil
}

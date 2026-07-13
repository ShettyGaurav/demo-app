package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

type serviceTarget struct {
	Name string
	URL  string
}

type serviceHealth struct {
	Service   string      `json:"service"`
	URL       string      `json:"url"`
	Status    string      `json:"status"`
	LatencyMs float64     `json:"latency_ms,omitempty"`
	Detail    interface{} `json:"detail,omitempty"`
	Error     string      `json:"error,omitempty"`
}

type aggregateResponse struct {
	Overall   string          `json:"overall"`
	CheckedAt string          `json:"checked_at"`
	Services  []serviceHealth `json:"services"`
	Notes     []string        `json:"notes,omitempty"`
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func loadTargets() []serviceTarget {
	return []serviceTarget{
		{Name: "auth-service", URL: envOrDefault("AUTH_SERVICE_URL", "http://localhost:3001")},
		{Name: "analytics-engine", URL: envOrDefault("ANALYTICS_ENGINE_URL", "http://localhost:8000")},
		{Name: "notifier-service", URL: envOrDefault("NOTIFIER_SERVICE_URL", "http://localhost:3002")},
		{Name: "api-gateway", URL: envOrDefault("API_GATEWAY_URL", "http://localhost:3000")},
	}
}

func checkService(client *http.Client, target serviceTarget) serviceHealth {
	healthURL := target.URL + "/healthz"
	start := time.Now()

	resp, err := client.Get(healthURL)
	latency := float64(time.Since(start).Milliseconds())

	result := serviceHealth{
		Service:   target.Name,
		URL:       healthURL,
		LatencyMs: latency,
	}

	if err != nil {
		result.Status = "unreachable"
		result.Error = err.Error()
		return result
	}
	defer resp.Body.Close()

	var body map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		result.Status = "degraded"
		result.Error = "invalid health response"
		return result
	}

	result.Detail = body
	if resp.StatusCode == http.StatusOK {
		result.Status = "healthy"
	} else {
		result.Status = "unhealthy"
		result.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}

	return result
}

func aggregateHandler(w http.ResponseWriter, r *http.Request) {
	targets := loadTargets()
	client := &http.Client{Timeout: 3 * time.Second}

	results := make([]serviceHealth, len(targets))
	var wg sync.WaitGroup

	for i, target := range targets {
		wg.Add(1)
		go func(idx int, t serviceTarget) {
			defer wg.Done()
			results[idx] = checkService(client, t)
		}(i, target)
	}
	wg.Wait()

	overall := "healthy"
	for _, sh := range results {
		if sh.Status != "healthy" {
			overall = "degraded"
			break
		}
	}

	response := aggregateResponse{
		Overall:   overall,
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
		Services:  results,
		Notes: []string{
			"task-worker has no HTTP endpoint; verify via Redis queue and worker logs",
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if overall != "healthy" {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	json.NewEncoder(w).Encode(response)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"service":   "health-aggregator",
		"status":    "healthy",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"runtime":   "ubi9-minimal",
	})
}

func main() {
	port := envOrDefault("PORT", "3003")

	http.HandleFunc("/healthz", healthHandler)
	http.HandleFunc("/aggregate", aggregateHandler)

	fmt.Printf("Health Aggregator running on port %s (ubi9-minimal)\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		os.Exit(1)
	}
}

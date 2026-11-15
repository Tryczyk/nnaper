package osm

import (
	"testing"
	"time"
)

func TestCalculateBackoff(t *testing.T) {
	if b := CalculateBackoff(0, 15); b != 15*time.Minute {
		t.Fatalf("expected 15m, got %v", b)
	}
	if b := CalculateBackoff(1, 15); b != 15*time.Minute {
		t.Fatalf("expected 15m, got %v", b)
	}
	if b := CalculateBackoff(2, 15); b != 30*time.Minute {
		t.Fatalf("expected 30m, got %v", b)
	}
	if b := CalculateBackoff(3, 15); b != 60*time.Minute {
		t.Fatalf("expected 60m, got %v", b)
	}
	if b := CalculateBackoff(4, 15); b != 120*time.Minute {
		t.Fatalf("expected 120m, got %v", b)
	}
	// Max cap at 120 min
	if b := CalculateBackoff(10, 15); b != 120*time.Minute {
		t.Fatalf("expected capped at 120m, got %v", b)
	}
}

func TestShouldRun_AutoDisabled(t *testing.T) {
	st := UpdateStatus{
		AutoUpdateEnabled: false,
		PreferredHour:     3,
	}
	now := time.Date(2026, 11, 15, 3, 0, 0, 0, time.UTC)
	should, reason := ShouldRun(now, st)
	if should {
		t.Fatalf("expected should=false when auto-update disabled, got true (%s)", reason)
	}
}

func TestShouldRun_CatchUpNoPreviousUpdate(t *testing.T) {
	st := UpdateStatus{
		AutoUpdateEnabled:    true,
		PreferredHour:        3,
		RetryIntervalMin:     15,
		LastSuccessfulUpdate: nil,
	}
	now := time.Date(2026, 11, 15, 14, 0, 0, 0, time.UTC) // afternoon
	should, _ := ShouldRun(now, st)
	if !should {
		t.Fatalf("expected should=true for catch-up when no previous update exists")
	}
}

func TestShouldRun_CatchUpOver24Hours(t *testing.T) {
	past := time.Date(2026, 11, 13, 3, 0, 0, 0, time.UTC) // 2 days ago
	st := UpdateStatus{
		AutoUpdateEnabled:    true,
		PreferredHour:        3,
		RetryIntervalMin:     15,
		LastSuccessfulUpdate: &past,
	}
	now := time.Date(2026, 11, 15, 11, 30, 0, 0, time.UTC) // 11:30 AM
	should, _ := ShouldRun(now, st)
	if !should {
		t.Fatalf("expected should=true for catch-up when >24h elapsed")
	}
}

func TestShouldRun_NightWindow(t *testing.T) {
	yesterdayNight := time.Date(2026, 11, 14, 3, 5, 0, 0, time.UTC)
	st := UpdateStatus{
		AutoUpdateEnabled:    true,
		PreferredHour:        3,
		RetryIntervalMin:     15,
		LastSuccessfulUpdate: &yesterdayNight,
	}

	// 1. Outside night window (e.g. 18:00 on the same day, <24h elapsed)
	nowOutside := time.Date(2026, 11, 14, 18, 0, 0, 0, time.UTC)
	should, _ := ShouldRun(nowOutside, st)
	if should {
		t.Fatalf("expected should=false outside night window when last update is <24h ago")
	}

	// 2. In night window (03:15)
	nowNight := time.Date(2026, 11, 15, 3, 15, 0, 0, time.UTC)
	shouldNight, _ := ShouldRun(nowNight, st)
	if !shouldNight {
		t.Fatalf("expected should=true during night window for new day")
	}

	// 3. In night window, but already executed today
	todayNight := time.Date(2026, 11, 15, 3, 2, 0, 0, time.UTC)
	st.LastSuccessfulUpdate = &todayNight
	shouldDup, _ := ShouldRun(nowNight, st)
	if shouldDup {
		t.Fatalf("expected should=false when night update already ran today")
	}
}

func TestShouldRun_RetryBackoff(t *testing.T) {
	failedTime := time.Date(2026, 11, 15, 3, 0, 0, 0, time.UTC)
	st := UpdateStatus{
		AutoUpdateEnabled:    true,
		PreferredHour:        3,
		RetryIntervalMin:     15,
		LastStatus:           "FAILED",
		LastAttemptAt:        &failedTime,
		ConsecutiveFailures:  1,
		LastSuccessfulUpdate: nil,
	}

	// Too early (5 minutes after failure, retry interval is 15 min)
	nowTooEarly := time.Date(2026, 11, 15, 3, 5, 0, 0, time.UTC)
	shouldEarly, _ := ShouldRun(nowTooEarly, st)
	if shouldEarly {
		t.Fatalf("expected should=false during backoff window")
	}

	// Ready (16 minutes after failure)
	nowReady := time.Date(2026, 11, 15, 3, 16, 0, 0, time.UTC)
	shouldReady, _ := ShouldRun(nowReady, st)
	if !shouldReady {
		t.Fatalf("expected should=true after backoff interval passed")
	}
}

package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHashAndVerifyPassword(t *testing.T) {
	passwords := []string{
		"superSecret123!",
		"TrudneHaslo#2026",
		"zaq1@WSX",
	}

	for _, p := range passwords {
		hashed := HashPassword(p)
		if hashed == "" || hashed == p {
			t.Fatalf("HashPassword should return non-empty hashed string, got %s", hashed)
		}
		if !VerifyPassword(p, hashed) {
			t.Errorf("VerifyPassword failed to verify correct password %q", p)
		}
		if VerifyPassword(p+"wrong", hashed) {
			t.Errorf("VerifyPassword succeeded with incorrect password")
		}
	}
}

func TestHashPasswordSaltUnique(t *testing.T) {
	p := "identicalPassword123"
	h1 := HashPassword(p)
	h2 := HashPassword(p)
	if h1 == h2 {
		t.Errorf("HashPassword should produce different hashes for same password due to random salt")
	}
}

func TestGenerateToken(t *testing.T) {
	t1 := GenerateToken()
	t2 := GenerateToken()

	if len(t1) < 32 {
		t.Errorf("expected token length >= 32, got %d", len(t1))
	}
	if t1 == t2 {
		t.Errorf("expected generated tokens to be unique, got identical %s", t1)
	}
}

func TestExtractToken(t *testing.T) {
	expected := "test-token-12345"

	// 1. Authorization: Bearer
	req1 := httptest.NewRequest("GET", "/api/test", nil)
	req1.Header.Set("Authorization", "Bearer "+expected)
	if got := ExtractToken(req1); got != expected {
		t.Errorf("ExtractToken from Bearer failed: got %q, want %q", got, expected)
	}

	// 2. Cookie
	req2 := httptest.NewRequest("GET", "/api/test", nil)
	req2.AddCookie(&http.Cookie{Name: "token", Value: expected})
	if got := ExtractToken(req2); got != expected {
		t.Errorf("ExtractToken from Cookie failed: got %q, want %q", got, expected)
	}

	// 3. Query string fallback
	req3 := httptest.NewRequest("GET", "/api/test?token="+expected, nil)
	if got := ExtractToken(req3); got != expected {
		t.Errorf("ExtractToken from query failed: got %q, want %q", got, expected)
	}

	// 4. Empty request
	req4 := httptest.NewRequest("GET", "/api/test", nil)
	if got := ExtractToken(req4); got != "" {
		t.Errorf("ExtractToken from empty req failed: got %q, want empty", got)
	}
}

func TestUserContext(t *testing.T) {
	ctx := context.Background()
	if u := UserFromContext(ctx); u != nil {
		t.Errorf("expected nil user from empty context, got %+v", u)
	}

	testUser := &User{
		UserID:   "11111111-2222-3333-4444-555555555555",
		Username: "tester",
	}
	ctxWithUser := context.WithValue(ctx, UserContextKey, testUser)
	if u := UserFromContext(ctxWithUser); u == nil || u.Username != "tester" {
		t.Errorf("expected tester user, got %+v", u)
	}
}

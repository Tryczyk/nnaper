package parser

import (
	"bytes"
	"math"
	"testing"
)

func TestDDMToDD(t *testing.T) {
	// 5421.1234 N -> 54 deg + 21.1234/60 mins = 54.35205666...
	dd, ok := DDMToDD("5421.1234", "N")
	if !ok {
		t.Fatalf("expected ok=true for valid DDM")
	}
	expected := 54.0 + (21.1234 / 60.0)
	if math.Abs(dd-expected) > 1e-6 {
		t.Errorf("got %f, want %f", dd, expected)
	}

	// 01830.5000 E -> 18 deg + 30.5/60 mins = 18.508333...
	dd, ok = DDMToDD("01830.5000", "E")
	if !ok {
		t.Fatalf("expected ok=true for valid DDM")
	}
	expected = 18.0 + (30.5 / 60.0)
	if math.Abs(dd-expected) > 1e-6 {
		t.Errorf("got %f, want %f", dd, expected)
	}

	// South should be negative
	dd, ok = DDMToDD("5421.1234", "S")
	if !ok || dd >= 0 {
		t.Errorf("expected negative dd for South, got %f", dd)
	}

	// West should be negative
	dd, ok = DDMToDD("01830.5000", "W")
	if !ok || dd >= 0 {
		t.Errorf("expected negative dd for West, got %f", dd)
	}

	// Invalid inputs
	if _, ok := DDMToDD("", "N"); ok {
		t.Errorf("expected ok=false for empty string")
	}
	if _, ok := DDMToDD("abc", "N"); ok {
		t.Errorf("expected ok=false for non-numeric string")
	}
}

func TestParseNMEATime(t *testing.T) {
	h, m, s, nanos, ok := ParseNMEATime("123456.789")
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if h != 12 || m != 34 || s != 56 {
		t.Errorf("expected 12:34:56, got %d:%d:%d", h, m, s)
	}
	if nanos != 789000000 {
		t.Errorf("expected 789000000 nanos, got %d", nanos)
	}

	// Invalid
	if _, _, _, _, ok := ParseNMEATime("12"); ok {
		t.Errorf("expected ok=false for short string")
	}
	if _, _, _, _, ok := ParseNMEATime("abcdef"); ok {
		t.Errorf("expected ok=false for non-numeric time")
	}
}

func TestParseNMEADate(t *testing.T) {
	year, m, d, ok := ParseNMEADate("151126")
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if year != 2026 || m != 11 || d != 15 {
		t.Errorf("expected 2026-11-15, got %d-%02d-%02d", year, m, d)
	}

	// Old year (>80 -> 19xx)
	year, m, d, ok = ParseNMEADate("010199")
	if !ok || year != 1999 {
		t.Errorf("expected year 1999, got %d", year)
	}

	// Invalid
	if _, _, _, ok := ParseNMEADate("123"); ok {
		t.Errorf("expected ok=false for invalid date")
	}
}

func TestNMEAParserStream(t *testing.T) {
	// Przykładowy strumień NMEA zawierający RMC, GGA i GSV
	nmeaData := `$GPRMC,123519,A,5421.1234,N,01830.5000,E,022.4,084.4,230326,003.1,W*6A
$GPGGA,123519,5421.1234,N,01830.5000,E,1,08,0.9,54.2,M,46.9,M,,*47
$GPGSV,1,1,04,02,45,120,42,05,30,060,38,09,15,210,35,12,60,300,45*79
$GPRMC,123520,A,5421.1500,N,01830.5200,E,025.1,085.0,230326,003.1,W*6B
$GPGGA,123520,5421.1500,N,01830.5200,E,1,08,0.9,55.0,M,46.9,M,,*46
`
	reader := bytes.NewReader([]byte(nmeaData))
	parser := NewNMEAParserWithFilters("test-profile", DefaultNMEAFilterOptions(), nil, 0, 0, int64(len(nmeaData)))

	var receivedEpochs []*Epoch
	err := parser.ParseStream(reader, func(batch []*Epoch) error {
		receivedEpochs = append(receivedEpochs, batch...)
		return nil
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error parsing NMEA stream: %v", err)
	}

	if len(receivedEpochs) != 2 {
		t.Fatalf("expected 2 parsed epochs, got %d", len(receivedEpochs))
	}

	ep1 := receivedEpochs[0]
	if math.Abs(ep1.Lat-54.352056) > 1e-4 || math.Abs(ep1.Lon-18.508333) > 1e-4 {
		t.Errorf("unexpected coordinates for ep1: (%f, %f)", ep1.Lat, ep1.Lon)
	}
	if ep1.AltitudeM == nil || *ep1.AltitudeM != 54.2 {
		t.Errorf("expected altitude 54.2, got %v", ep1.AltitudeM)
	}
	if len(ep1.Satellites) != 4 {
		t.Errorf("expected 4 satellites from GSV, got %d", len(ep1.Satellites))
	}
}

func TestNMEAFilterToggles(t *testing.T) {
	// Punkt o prędkości 300 km/h (ok. 162 węzłów) i 2 satelitach
	nmeaData := `$GPRMC,123519,A,5421.1234,N,01830.5000,E,162.0,084.4,230326,003.1,W*6A
$GPGGA,123519,5421.1234,N,01830.5000,E,1,02,0.9,54.2,M,46.9,M,,*4d
`
	// Test 1: Filtry aktywne -> punkt powinien być odrzucony ze względu na min_satellites=4 i max_speed=250
	fActive := DefaultNMEAFilterOptions()
	fActive.MinSatellites = 4
	fActive.MaxSpeedKmh = 250
	p1 := NewNMEAParserWithFilters("test", fActive, nil, 0, 0, int64(len(nmeaData)))
	var countActive int
	_ = p1.ParseStream(bytes.NewReader([]byte(nmeaData)), func(batch []*Epoch) error {
		countActive += len(batch)
		return nil
	}, nil)
	if countActive != 0 {
		t.Fatalf("expected 0 epochs with active filters, got %d", countActive)
	}

	// Test 2: Wybieraki wyłączone (EnableSatellites = false, EnableMaxSpeed = false) -> punkt powinien zostać zaakceptowany
	fDisabled := DefaultNMEAFilterOptions()
	fDisabled.EnableSatellites = false
	fDisabled.EnableMaxSpeed = false
	p2 := NewNMEAParserWithFilters("test", fDisabled, nil, 0, 0, int64(len(nmeaData)))
	var countDisabled int
	_ = p2.ParseStream(bytes.NewReader([]byte(nmeaData)), func(batch []*Epoch) error {
		countDisabled += len(batch)
		return nil
	}, nil)
	if countDisabled != 1 {
		t.Fatalf("expected 1 epoch with disabled filter toggles, got %d", countDisabled)
	}
}

func TestNMEASpeedFromJumpNotData(t *testing.T) {
	// Punkt 1: Gdańsk 12:35:19
	// Punkt 2: Gdańsk 12:35:20 (~20m dalej, prędkość skoku ~72 km/h), mimo że RMC podaje 0 węzłów
	// Punkt 3: Bałtyk 12:35:21 (skok ~50 km w 1 sekundy = 180 000 km/h!), mimo że RMC podaje "poprawne" 5.0 węzłów
	// Punkt 4: status 'V' (Void/Warning) w RMC -> odrzucenie
	nmeaData := `$GPRMC,123519,A,5421.1234,N,01830.5000,E,000.0,084.4,230326,003.1,W*6A
$GPGGA,123519,5421.1234,N,01830.5000,E,1,08,0.9,54.2,M,46.9,M,,*47
$GPRMC,123520,A,5421.1350,N,01830.5000,E,000.0,084.4,230326,003.1,W*6A
$GPGGA,123520,5421.1350,N,01830.5000,E,1,08,0.9,54.2,M,46.9,M,,*47
$GPRMC,123521,A,5445.0000,N,01845.0000,E,005.0,084.4,230326,003.1,W*6A
$GPGGA,123521,5445.0000,N,01845.0000,E,1,08,0.9,54.2,M,46.9,M,,*47
$GPRMC,123522,V,5421.1400,N,01830.5000,E,010.0,084.4,230326,003.1,W*6A
$GPGGA,123522,5421.1400,N,01830.5000,E,1,08,0.9,54.2,M,46.9,M,,*47
`
	opts := DefaultNMEAFilterOptions()
	opts.MaxSpeedKmh = 250.0 // odcięcie skoków powyżej 250 km/h
	parser := NewNMEAParserWithFilters("test-profile", opts, nil, 0, 0, int64(len(nmeaData)))

	var received []*Epoch
	err := parser.ParseStream(bytes.NewReader([]byte(nmeaData)), func(batch []*Epoch) error {
		received = append(received, batch...)
		return nil
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Oczekujemy dokładnie 2 zaakceptowanych punktów (punkt 1 i punkt 2).
	// Punkt 3 (skok na Bałtyk 180k km/h) i Punkt 4 (status V) muszą być odrzucone!
	if len(received) != 2 {
		t.Fatalf("expected 2 epochs, got %d", len(received))
	}

	// Prędkość pierwszego punktu = 0
	if received[0].SpeedKmh != 0 {
		t.Errorf("expected ep1 speed=0, got %f", received[0].SpeedKmh)
	}
	// Prędkość drugiego punktu powinna być wyliczona ze skoku (~77 km/h), a NIE 0 z RMC!
	if received[1].SpeedKmh < 50 || received[1].SpeedKmh > 100 {
		t.Errorf("expected ep2 speed from jump ~77 km/h, got %f", received[1].SpeedKmh)
	}
}

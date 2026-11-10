package osm

import (
	"os"
	"testing"
)

func TestClassifyInfrastructure(t *testing.T) {
	cases := []struct {
		tags     map[string]string
		wantType string
	}{
		{map[string]string{"highway": "traffic_signals"}, "traffic_signals"},
		{map[string]string{"traffic_calming": "bump"}, "speed_bump"},
		{map[string]string{"traffic_calming": "hump"}, "speed_bump"},
		{map[string]string{"highway": "crossing"}, "crossing"},
		{map[string]string{"highway": "speed_camera"}, "speed_camera"},
		{map[string]string{"amenity": "bench"}, ""},
	}

	for i, tc := range cases {
		gotType, _ := classifyNodeInfrastructure(tc.tags)
		if gotType != tc.wantType {
			t.Errorf("case %d: classifyNodeInfrastructure(%v) = %q, want %q",
				i, tc.tags, gotType, tc.wantType)
		}
	}
}

func TestClassifyPOI(t *testing.T) {
	tags := map[string]string{
		"amenity":       "restaurant",
		"name":          "Restauracja Gdańska",
		"opening_hours": "Mo-Su 10:00-22:00",
	}
	cat, sub := classifyPOI(tags)
	if cat != "restaurant" || sub != "restaurant" {
		t.Fatalf("expected restaurant POI, got cat=%q sub=%q", cat, sub)
	}

	churchTags := map[string]string{
		"amenity":  "place_of_worship",
		"religion": "christian",
		"name":     "Bazylika Mariacka",
	}
	cat2, _ := classifyPOI(churchTags)
	if cat2 == "" {
		t.Fatalf("expected non-empty POI category for church")
	}
}

func TestClassifyRoadWay(t *testing.T) {
	if !isDrivableHighway("primary") {
		t.Fatalf("expected primary highway to be drivable")
	}
	spd := parseRoadSpeed("primary", "70")
	if spd != 70 {
		t.Fatalf("expected parsed speed 70, got %f", spd)
	}
}

func TestReadPomorskiePBFHeader(t *testing.T) {
	pbfPath := "../../osm_data/pomorskie.osm.pbf"
	if _, err := os.Stat(pbfPath); os.IsNotExist(err) {
		t.Skip("pomorskie.osm.pbf not present in test environment")
	}
	f, err := os.Open(pbfPath)
	if err != nil {
		t.Fatalf("failed to open pbf: %v", err)
	}
	defer f.Close()

	buf := make([]byte, 64)
	n, err := f.Read(buf)
	if err != nil || n < 16 {
		t.Fatalf("failed to read pbf header bytes: n=%d err=%v", n, err)
	}
}

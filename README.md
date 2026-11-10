<p align="center">
  <img src="assets/header.svg" alt="NNAPER Header" width="100%" />
</p>

# NNAPER - Telemetryczna Platforma GPS w Go & PostGIS

Wysokowydajna platforma do strumieniowego przetwarzania, dociągania do sieci dróg (**Map Matching OSRM**), analizy i interaktywnej wizualizacji danych telemetrycznych GPS (NMEA, GPX, CSV). 

Cały backend oraz silnik przetwarzania danych zostały zrealizowane w **Go 1.24**, współpracując z przestrzenną bazą danych **PostgreSQL 16 + PostGIS 3.4**, lokalnym silnikiem routingu **OSRM**, wektorowym podkładem **PMTiles** (OpenStreetMap) oraz dynamicznym generowaniem kafelków wektorowych **MVT** (`ST_AsMVT`) bezpośrednio w locie.

---

## Główne możliwości platformy

### 1. Ultra-szybki silnik parsowania i Map Matchingu (Go)
* **Wydajność 15–30 MB/s**: Przetwarzanie plików o rozmiarach od kilkunastu kilobajtów do gigabajtów (nawet 650 MB – 10 GB) ze znikomym zużyciem pamięci RAM (~25 MB).
* **Obsługiwane formaty**:
  * **NMEA 0183**: Pełna agregacja cykli `$GPRMC`, `$GPGGA`, `$GPGSV` (satelity) oraz `$GSENSORD` (trójosiowe przeciążenia akcelerometru $G_x$, $G_y$, $G_z$).
  * **GPX**: Ślady rejestrowane przez zegarki i aplikacje sportowe (Garmin, Strava).
  * **CSV**: Elastyczne dopasowywanie kolumn (szerokość, długość, czas, akceleracja).
* **Map Matching OSRM**: Równoległe (16 wątków) dopasowywanie punktów do sieci ulic z natychmiastową interpolacją wektorową geometrii dróg (`LINESTRING`).
* **Zadania w tle i trwałość**: Pełna asynchroniczność zadań na serwerze z zapisem stanu na dysku (`jobs_state.json`). Odświeżenie przeglądarki czy restart serwera nie gubi postępu ani importowanego pliku.

### 2. Dynamiczne kafelki wektorowe MVT (`/api/track/{z}/{x}/{y}.pbf`)
* Generowanie kafelków wektorowych bezpośrednio z PostGIS w czasie poniżej 10 milisekund za pomocą `ST_AsMVT` i `ST_TileEnvelope`.
* **Przełącznik Snap ON / OFF**: Natychmiastowe przełączanie między surowym śladem GPS a trasą dociągniętą do geometrii dróg bez ponownego pobierania danych.
* Pamięć podręczna w RAM z automatycznym czyszczeniem po dodaniu lub usunięciu śladów.

### 3. Zintegrowany odtwarzacz trasy (Playback & HUD)
* Płynna animacja rekonstrukcji przejazdu wzdłuż zarejestrowanego śladu GPS z kursem pojazdu.
* **Wskaźniki HUD w czasie rzeczywistym**: prędkość chwilowa, wysokość n.p.m., przeciążenia 3D ($G_x$, $G_y$, $G_z$), dystans, czas i satelity.
* **Interaktywny panel wykresów**:
  * **Profil wysokości**: Wykres przewyższeń z interaktywnym suwakiem przewijania trasy.
  * **Diagram G-G (G-Force)**: Wizualizacja sił odśrodkowych w zakrętach oraz przyspieszania / hamowania.
* **Wizualizacja satelitów**: Lokalny skyplot (nieboskłon) oraz sferyczny model orbity MEO (~20 200 km).

### 4. Planer trasy i integracja z Google Maps
* Wyznaczanie optymalnej trasy drogowej przez silnik OSRM z dowolną liczbą punktów pośrednich i zmianą kolejności.
* Dwukierunkowa integracja: wczytywanie gotowych tras ze schowka (z linku Google Maps) oraz eksport jednym kliknięciem do Google Maps.

### 5. Zaawansowany eksport danych
* Eksport tras z dowolnego zakresu (dzień, miesiąc, rok, widok mapy, wszystko):
  * **HTML**: Samodzielna interaktywna mapa offline ze śladem i profilem trasy.
  * **PNG / SVG**: Render grafiki wektorowej/rastrowej z gradientem prędkości i legendą.
  * **GIF**: Płynna animacja przejazdu samochodu.
  * **GPX / CSV / GeoJSON / KML**: Standardowe formaty do analizy w arkuszach lub importu do Garmin, Strava i Google Earth.

---

## Architektura i struktura projektu

```
nnaper/
├── assets/                  # Ikony, logotypy i grafiki wektorowe SVG
├── cmd/                     # Punkty wejściowe aplikacji wykonywalnych:
│   └── nnaper-parser/       # Samodzielne narzędzie CLI parsera (nnaper-parser.exe)
├── data/                    # Dane lokalne, logi telemetryczne, stan (ignorowane w Git)
├── internal/                # Pakiety domenowe serwera Go:
│   ├── auth/                # Rejestracja, logowanie, tokeny i profile użytkowników
│   ├── config/              # Konfiguracja środowiska (.env)
│   ├── dates/               # Hierarchiczne drzewo lat, miesięcy i dni
│   ├── db/                  # Pula połączeń pgxpool PostgreSQL/PostGIS
│   ├── epochs/              # Punkty telemetryczne, usuwanie, odtwarzanie (playback-day)
│   ├── export/              # Pobieranie i generowanie eksportu danych
│   ├── jobs/                # Menedżer asynchronicznych zadań w tle i recovery
│   ├── parser/              # Silnik strumieniowego parsowania NMEA/GPX/CSV i OSRM
│   └── tiles/               # Dynamiczne kafelki wektorowe MVT (ST_AsMVT) i cache
├── maps/                    # Statyczne pliki frontendu (HTML, CSS, JS):
│   ├── app.js               # Główna logika interfejsu mapy i filtr czasu
│   ├── auth-manager.js      # Panel logowania, rejestracji i profili
│   ├── export-manager.js    # Eksport tras (HTML, PNG, SVG, GIF, GPX, CSV, KML)
│   ├── layer-manager.js     # Dynamiczny edytor stylów warstw mapy
│   ├── layers.js            # Definicje stylów MapLibre i kafelków PMTiles
│   ├── map.html             # Główny widok aplikacji
│   ├── parser-manager.js    # Modal importu, upload i monitoring zadań z ETA
│   ├── playback-inline.js   # Odtwarzacz trasy (HUD, G-G diagram, profil wysokości)
│   ├── route-inline.js      # Planer tras OSRM i integracja z Google Maps
│   ├── runtime-config.js    # Konfiguracja endpointów API i OSRM
│   └── styles.css           # Stylizacja interfejsu
├── osm_data/                # Pobrane wyciągi OSM (.osm.pbf) i podkład (.pmtiles)
├── osrm/                    # Profile routingu OSRM (car.lua)
├── .env.example             # Wzór zmiennych środowiskowych
├── docker-compose.yml       # Orkiestracja: PostGIS, Go API, OSRM, Planetiler, Caddy
├── Dockerfile               # Wielostopniowy build kontenera produkcyjnego Go
├── go.mod                   # Definicja modułu Go i zależności
├── go.sum                   # Sumy kontrolne zależności Go
├── init_db.sql              # Inicjalizacja schematu bazy PostGIS i indeksów GiST
├── main.go                  # Główny punkt wejścia serwera Go (Chi router, port 8000)
└── README.md                # Dokumentacja techniczna platformy
```

---

## Wymagania systemowe

* **Zainstalowane Go 1.24+** (przy uruchamianiu natywnym)
* **Docker Desktop / Docker Compose** (przy uruchamianiu kontenerowym)
* **Baza PostgreSQL 16 z rozszerzeniem PostGIS 3.4**

---

## Uruchomienie aplikacji

### Wariant 1: Uruchomienie natywne (Windows / Linux)

1. **Uruchomienie bazy danych i OSRM**:
   ```powershell
   docker compose up -d db osrm
   ```

2. **Kompilacja i start serwera Go**:
   ```powershell
   # Windows:
   go build -o nnaper-server.exe .
   .\nnaper-server.exe

   # Linux / macOS:
   go build -o nnaper-server .
   ./nnaper-server
   ```
   Serwer wystartuje na porcie `8000`, serwując zarówno API, jak i interfejs mapy (`http://localhost:8000/maps/map.html`).

---

### Wariant 2: Uruchomienie pełnego środowiska w Dockerze

Wszystkie usługi (PostGIS, Serwer Go, OSRM, Planetiler, Caddy) uruchamiane są jednym poleceniem:

```bash
docker compose up -d --build
```

Usługi będą dostępne pod adresami:
* **Interfejs mapy i podkład wektorowy (Caddy)**: <http://localhost:8080/maps/map.html>
* **Backend API (Go)**: <http://localhost:8000>
* **Silnik nawigacji drogowej (OSRM)**: <http://localhost:5000>

---

## Samodzielne narzędzie CLI do importu danych (`nnaper-parser`)

Jeśli chcesz przetworzyć potężny plik danych GPS bezpośrednio z wiersza poleceń bez otwierania przeglądarki:

```powershell
# Kompilacja narzędzia CLI:
go build -o nnaper-parser.exe ./cmd/nnaper-parser

# Uruchomienie parsowania:
.\nnaper-parser.exe -file "C:\dane\raw.txt" -profile-id "UUID-PROFILU" -snap=true
```

Flagi CLI:
* `-file` — Ścieżka do pliku `.txt`, `.log`, `.nmea`, `.gpx` lub `.csv`
* `-profile-id` — Identyfikator profilu docelowego w bazie danych
* `-snap` — Dociąganie do sieci dróg OSRM (domyślnie `true`)
* `-concurrency` — Liczba równoległych workerów OSRM (domyślnie `16`)
* `-chunk-size` — Rozmiar partii punktów wysyłanych do OSRM `/match` (domyślnie `100`)

---

## Licencja

Projekt objęty licencją MIT.

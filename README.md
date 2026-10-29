<p align="center">
  <img src="assets/header.png" alt="Header" width="100%" />
</p>

Aplikacja do przetwarzania i analizy danych lokalizacyjnych GPS w formacie **NMEA**, bezpośredniego strumieniowania ich do bazy danych **PostgreSQL + PostGIS**, serwowania przez mikroserwis **FastAPI** oraz zaawansowanej wizualizacji na interaktywnej mapie opartej o kafelki wektorowe **PMTiles** (OpenStreetMap), dynamiczne kafelki **MVT** ze śladem telemetrycznym oraz silnik routingu **OSRM**.

## Jak to działa?

1. **Infrastruktura kontenerowa (Docker Compose):**

   * **PostGIS (`db`)**: Relacyjna baza przestrzenna zainicjalizowana schematem z pliku `init_db.sql`.

   * **Backend API (`api`)**: Serwis FastAPI z asynchroniczną pulą połączeń `psycopg-pool`, serwujący kafelki wektorowe w locie (`ST_AsMVT`), telemetrię epok, strukturę dat oraz zoptymalizowany strumień danych odtwarzacza (`/api/playback-day`).

   * **Silnik routingu (`osrm`)**: Lokalna usługa OSRM na porcie `5000` wyznaczająca trasy drogowe na podstawie danych OpenStreetMap.

   * **Kafelki podkładowe OpenStreetMap (`tiles-downloader` + `tiles-generator`)**: Automatycznie pobiera wyciąg OSM z serwisu Geofabrik i kompresuje go do pojedynczego archiwum wektorowego `.pmtiles` za pomocą narzędzia **Planetiler**.

   * **Serwer WWW (`tiles-server`)**: Serwer HTTP **Caddy** generujący dynamiczną konfigurację runtime (`maps/runtime-config.local.js`) oraz serwujący interfejs mapy i kafelki PMTiles na porcie `8080`.

   * **Wskaźnik gotowości (`open-browser`)**: Pomocniczy kontener oczekujący na uruchomienie serwera WWW i wypisujący gotowy link do mapy w logach kontenera.

2. **Parsowanie i strumieniowanie NMEA (`data/raw.txt`):**

   * Skrypt `src/parser.py` odczytuje surowe logi NMEA linia po linii, grupując komunikaty (`$GPRMC`, `$GPGGA`, `$GPGSV`, `$GSENSORD`) w spójne epoki pomiarowe.

   * Dokonuje walidacji jakości fixa GPS i współczynnika HDOP oraz zapisuje dane partiami za pomocą protokołu `COPY` do bufora ze stagingiem i klauzulą `ON CONFLICT (profile_id, timestamp) DO NOTHING`.

   * Plik `data/state.txt` oraz unikalne ograniczenie na poziomie bazy danych gwarantują brak duplikatów przy minimalnym zużyciu pamięci RAM.

3. **Interfejs mapy i narzędzia wizualizacji (`maps/tile_map.html`):**

   * **Sterowanie warstwami podkładu (lewy panel):** Dynamiczne drzewo warstw z możliwością edycji kolorów, grubości linii, linii przerywanych, obwódek oraz widoczności elementów, zarządzane przez `maps/layer-manager.js` z persystencją w `localStorage`.

   * **Panel tras i nawigacji (prawy panel):** Szybki dostęp do replayu trasy, planera oraz niezależnych przełączników widoku 3D (ukształtowanie terenu oraz trójwymiarowe bryły budynków).

   * **Hierarchiczny filtr czasu:** Selektywny wybór lat, miesięcy i poszczególnych dni z dynamicznym przełączaniem warstw MVT bez konieczności ponownego ładowania danych pozostałych miesięcy.

   * **Inspekcja punktów telemetrycznych:** Kliknięcie w dowolny punkt śladu GPS otwiera panel szczegółów epoki: dokładny timestamp, prędkość, wysokość, przeciążenia 3D z akcelerometru (Gx, Gy, Gz) oraz bieżący układ satelitów.

   * **Wizualizacja satelitów:** Wizualizacja pozycji i promieni satelitów w dwóch trybach: lokalnym (nieboskłon / skyplot) lub globalnym sferycznym (orbita MEO \~20 200 km).

   * **Wyszukiwarka i geokodowanie:** Zintegrowana wyszukiwarka miejsc i adresów bazująca na API Photon (Komoot).

   * **Planer trasy drogowej (OSRM + Google Maps):** Wyznaczanie optymalnej trasy drogowej z obsługą wielu punktów pośrednich, zamiany kolejności (góra/dół), obsługi z menu kontekstowego mapy (PPM), kalkulacji czasu i dystansu przez OSRM, a także importowania trasy ze schowka (z linku Google Maps) oraz eksportu i otwierania trasy w Google Maps.

4. **Zintegrowany odtwarzacz trasy (Playback & HUD):**

   * Odtwarzacz trasy GPS jest w pełni zintegrowany z główną mapą (`maps/tile_map.html`, uruchamiany przyciskiem *Replay trasy* lub parametrem `?mode=playback`; plik `maps/playback.html` zachowuje kompatybilność jako automatyczne przekierowanie).

   * Symulacja przejazdu samochodem wzdłuż zarejestrowanego śladu GPS z automatycznym obrotem pojazdu zgodnie z kursem.

   * Panel HUD w czasie rzeczywistym: godzina pomiaru, prędkość chwilowa, wysokość n.p.m., przeciążenia akcelerometru 3D (Gx, Gy, Gz), dystans dnia, średnia prędkość oraz liczba satelitów.

   * Suwak osi czasu, regulacja tempa odtwarzania (1x–60x), automatyczne śledzenie pojazdu kamerą oraz synchronizowana wizualizacja promieni satelitów.

## Struktura projektu

```
nnaper/
├── data/
│   ├── raw.txt             # Surowe logi NMEA z urządzenia GPS (nieśledzone w Git)
│   └── state.txt           # Numer ostatnio przetworzonej linii z raw.txt
├── osm_data/               # Dane przestrzenne, wyciągi i kafelki:
│   ├── *.osm.pbf           # Pobrany wyciąg OSM (np. pomorskie.osm.pbf, ignorowany w Git)
│   └── *.pmtiles           # Wygenerowane kafelki wektorowe PMTiles (ignorowane w Git)
├── maps/
│   ├── app.js              # Główna logika interfejsu mapy, filtr czasu i inspekcja epok
│   ├── layer-manager.js    # Zarządzanie stylami warstw, persystencja w localStorage i synchronizacja
│   ├── layers.js           # Konfiguracja stylu MapLibre i definicje warstw PMTiles
│   ├── playback-inline.js  # Zintegrowany moduł odtwarzacza trasy GPS (HUD + animacja samochodu)
│   ├── playback.html       # Przekierowanie do zintegrowanego odtwarzacza w tile_map.html
│   ├── route-inline.js     # Moduł planowania trasy OSRM, obsługa Google Maps i menu kontekstowego
│   ├── runtime-config.js   # Domyślna konfiguracja runtime URL-i API, OSRM i kafelków
│   ├── styles.css          # Style CSS paneli, HUD-a, planera i wyszukiwarki
│   └── tile_map.html       # Główny interfejs mapy z panelami bocznymi i odtwarzaczem
├── src/
│   ├── constants.py        # Stałe konfiguracyjne i ścieżki projektu
│   ├── parser.py           # Parsowanie NMEA i zapis epok do PostgreSQL/PostGIS (COPY)
│   ├── server.py           # Backend FastAPI (dynamiczne MVT, telemetria epok, playback, pula połączeń)
│   └── utils.py            # Narzędzia pomocnicze (dekodowanie współrzędnych i czasu NMEA)
├── .env.example            # Wzór zmiennych środowiskowych
├── docker-compose.yml      # PostGIS, FastAPI, OSRM, Planetiler, Caddy i pomocniczy launcher
├── init_db.sql             # Schemat bazy danych, relacje, indeksy GiST i unikalne ograniczenia
├── pyproject.toml          # Konfiguracja środowiska i zależności (uv)
└── README.md
```

## Stos technologiczny

* **Środowisko i język:** Python 3.14, menedżer pakietów [uv](https://docs.astral.sh/uv/)

* **Baza danych przestrzennych:** PostgreSQL 16 + PostGIS 3.4

* **Backend API:** FastAPI, Uvicorn, sterownik `psycopg` (binary z obsługą `COPY`), pula połączeń `psycopg-pool`

* **Silnik routingu:** OSRM Backend (MLD)

* **Generowanie kafelków:** [Planetiler](https://github.com/onthegomap/planetiler) (Docker)

* **Format kafelków:** PMTiles (OpenMapTiles schema) oraz dynamiczne Mapbox Vector Tiles (MVT) generowane w locie przez `ST_AsMVT`

* **Frontend / Wizualizacja:** MapLibre GL JS, PMTiles Protocol, Caddy Server

* **Formaty danych:** NMEA 0183 ($GPRMC, $GPGGA, $GPGSV, $GSENSORD), PBF (OpenStreetMap), GeoJSON

## Wymagania wstępne

* Zainstalowany **Python 3.14+**

* Zainstalowane narzędzie [**uv**](https://docs.astral.sh/uv/)

* Zainstalowany **Docker Desktop** (wraz z obsługą Docker Compose)

## Konfiguracja i uruchomienie

### 1. Przygotowanie repozytorium

```
git clone https://github.com/Tryczyk/nnaper.git
cd nnaper
```

### 2. Konfiguracja zmiennych środowiskowych

Skopiuj wzorzec pliku konfiguracyjnego:

```
cp .env.example .env
```

W pliku `.env` wskaż parametry połączenia z bazą oraz nazwę wyciągu OSM (domyślnie `pomorskie.osm.pbf`):

```
DB_URL=postgresql://nnaper:nnaper@localhost:5432/nnaper_db
OSM_FILE_NAME=pomorskie.osm.pbf
PMTILES_FILE=pomorskie.pmtiles
API_PORT=8000
OSRM_PORT=5000
TILES_PORT=8080
API_PUBLIC_URL=http://localhost:8000
TILES_PUBLIC_URL=http://localhost:8080
OSRM_PUBLIC_URL=http://localhost:5000
```

Pozostale ustawienia, miedzy innymi dane dostepowe Postgresa, CORS, Photon, sciezki parsera oraz progi walidacji GPS, sa opisane w pliku `.env.example`.

> **Uwaga:** Pliki `.pbf`, `.pmtiles`, dane bazy danych oraz duże pliki `data/raw.txt` są wykluczone z repozytorium Git przez `.gitignore`.

### 3. Uruchomienie infrastruktury (Docker Compose)

Uruchom całe środowisko w tle:

```
docker compose up -d
```

> Kontenery automatycznie:
>
> 1. Zainicjalizują bazę danych PostGIS i schemat z `init_db.sql`.
>
> 2. Uruchomią backend FastAPI na porcie `8000`.
>
> 3. Sprawdzą obecność kafelków `.pmtiles` i wyciągu `.osm.pbf` (w razie potrzeby pobiorą plik z Geofabrik i wygenerują kafelki).
>
> 4. Przygotują graf OSRM i uruchomią silnik routingu na porcie `5000`.
>
> 5. Uruchomią serwer WWW Caddy serwujący mapę na porcie `8080`.
>
> 6. Wypiszą bezpośredni link do mapy w logach kontenera pomocniczego `nnaper_browser_launcher`.

### 4. Przetwarzanie danych lokalizacyjnych (Python)

Umieść surowy plik z logami GPS w katalogu `data/raw.txt`, a następnie uruchom proces parsowania:

```
uv run src/parser.py
```

*Skrypt strumieniuje odczytane epoki bezpośrednio do bazy PostgreSQL/PostGIS, logując postęp przetwarzania w konsoli i aktualizując znacznik w `data/state.txt`.*

### 5. Dostęp do aplikacji

* **Główna mapa, nawigacja i planer trasy:**

  <http://localhost:8080/maps/tile_map.html>

* **Zintegrowany odtwarzacz trasy GPS (Playback & HUD):**

  <http://localhost:8080/maps/tile_map.html?mode=playback> *(lub przekierowanie przez <http://localhost:8080/maps/playback.html>)*

## Przy pracy nad bazą lub parserem

W trakcie modyfikowania struktury SQL (`init_db.sql`) lub reguł kwalifikacji w parserze (`src/parser.py`), najszybszym sposobem na zresetowanie środowiska, wyczyszczenie wolumenu i załadowanie danych od nowa jest sekwencja:

### Pełny reset bazy i ponowne sparsowanie logów

```
# 1. Zatrzymanie kontenerów i usunięcie starego wolumenu bazy
docker compose down -v

# 2. Uruchomienie infrastruktury na czysto (z załadowaniem aktualnego init_db.sql)
docker compose up -d

# 3. Zresetowanie wskaźnika przetworzonych linii do zera
Set-Content -Path "data/state.txt" -Value "0"

# 4. Ponowne uruchomienie parsera
uv run src/parser.py
```
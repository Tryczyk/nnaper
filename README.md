Aplikacja do przetwarzania i analizy danych lokalizacyjnych GPS w formacie **NMEA**, bezpośredniego strumieniowania ich do bazy danych **PostgreSQL + PostGIS**, serwowania przez mikroserwis **FastAPI** oraz zaawansowanej wizualizacji na interaktywnej mapie opartej o kafelki wektorowe **PMTiles** (OpenStreetMap), dynamiczne kafelki **MVT** ze śladem telemetrycznym oraz silnik routingu **OSRM**.

## Jak to działa?

1. **Infrastruktura kontenerowa (Docker Compose):**

   * **PostGIS (`db`)**: Relacyjna baza przestrzenna zainicjalizowana schematem z pliku `init_db.sql`.

   * **Backend API (`api`)**: Serwis FastAPI serwujący kafelki wektorowe w locie (`ST_AsMVT`), telemetrię epok, strukturę dat oraz dane playbacku.

   * **Silnik routingu (`osrm`)**: Lokalna usługa OSRM na porcie `5000` wyznaczająca trasy drogowe na podstawie danych OpenStreetMap.

   * **Kafelki podkładowe OpenStreetMap (`tiles-downloader` + `tiles-generator`)**: Automatycznie pobiera wyciąg OSM z serwisu Geofabrik i kompresuje go do pojedynczego archiwum wektorowego `.pmtiles` za pomocą narzędzia **Planetiler**.

   * **Serwer WWW (`tiles-server`)**: Serwer HTTP **Caddy** serwujący interfejs mapy oraz kafelki PMTiles na porcie `8080`.

2. **Parsowanie i strumieniowanie NMEA (`data/raw.txt`):**

   * Skrypt `src/parser.py` odczytuje surowe logi NMEA linia po linii, grupując komunikaty w spójne epoki pomiarowe.

   * Dokonuje walidacji jakości fixa GPS i współczynnika HDOP oraz zapisuje dane partiami bezpośrednio do bazy za pomocą protokołu `COPY`.

   * Plik `data/state.txt` oraz unikalny indeks czasowy zapobiegają duplikatom i pozwalają na bezpieczne wznawianie pracy w dowolnym momencie.

3. **Interfejs mapy i narzędzia wizualizacji (`maps/tile_map.html`):**

   * **Sterowanie warstwami podkładu:** Dynamiczne drzewo warstw z możliwością edycji kolorów, grubości linii, linii przerywanych, obwódek oraz widoczności budynków 3D.

   * **Hierarchiczny filtr czasu:** Selektywny wybór lat, miesięcy i poszczególnych dni z dynamicznym przełączaniem warstw MVT bez konieczności ponownego ładowania danych pozostałych miesięcy.

   * **Wizualizacja satelitów:** Wizualizacja pozycji i promieni satelitów w dwóch trybach: lokalnym (nieboskłon / skyplot) lub globalnym sferycznym (orbita MEO \~20 200 km).

   * **Wyszukiwarka i geokodowanie:** Zintegrowana wyszukiwarka miejsc i adresów bazująca na API Photon (Komoot).

   * **Planer trasy:** Wyznaczanie optymalnej trasy drogowej z obsługą punktów pośrednich, zamiany kolejności (góra/dół), obsługi z menu kontekstowego mapy (PPM) oraz kalkulacją czasu i dystansu przez OSRM.

4. **Dedykowany odtwarzacz trasy (`maps/playback.html`):**

   * Symulacja przejazdu samochodem wzdłuż zarejestrowanego śladu GPS z automatycznym obrotem pojazdu zgodnie z kursem.

   * Panel HUD w czasie rzeczywistym: godzina pomiaru, prędkość chwilowa, kurs, dystans dnia, średnia prędkość oraz liczba satelitów.

   * Suwak osi czasu, regulacja tempa odtwarzania (1x–60x), automatyczne śledzenie pojazdu kamerą oraz synchronizowana wizualizacja promieni satelitów.

5. **Wykresy analityczne (`src/plots.py`):**

   * Skrypt generuje samodzielne, interaktywne wykresy HTML w bibliotece Plotly (m.in. trójwymiarowy rozkład przeciążeń akcelerometru 3D, biegunowy skyplot satelitów, histogramy prędkości i kursów, analiza parametrów DOP).

## Struktura projektu

```
nnaper/
├── data/
│   ├── raw.txt             # Surowe logi NMEA z urządzenia GPS (nieśledzone w Git)
│   └── state.txt           # Numer ostatnio przetworzonej linii z raw.txt
├── osm_data/               # Dane przestrzenne, wyciągi i kafelki:
│   ├── *.osm.pbf           # Pobrany wyciąg OSM (np. pomorskie.osm.pbf, ignorowany w Git)
│   └── *.pmtiles           # Wygenerowane kafelki wektorowe PMTiles (ignorowane w Git)
├── plots/                  # Wygenerowane interaktywne wykresy HTML (Plotly)
├── maps/
│   ├── app.js              # Główna logika interfejsu mapy, filtr czasu i inspekcja epok
│   ├── layers.js           # Konfiguracja stylu MapLibre i definicje warstw PMTiles
│   ├── playback.html       # Dedykowany odtwarzacz trasy GPS (HUD + animacja samochodu)
│   ├── route-inline.js     # Moduł planowania trasy drogowej OSRM z menu kontekstowym
│   ├── styles.css          # Style CSS paneli, HUD-a i wyszukiwarki
│   └── tile_map.html       # Główny interfejs mapy
├── src/
│   ├── constants.py        # Stałe konfiguracyjne i ścieżki projektu
│   ├── parser.py           # Parsowanie NMEA i zapis epok do PostgreSQL/PostGIS (COPY)
│   ├── plots.py            # Generowanie interaktywnych wykresów HTML (Plotly)
│   ├── server.py           # Backend FastAPI (dynamiczne MVT, telemetria, OSRM proxy)
│   └── utils.py            # Narzędzia pomocnicze (dekodowanie współrzędnych i czasu NMEA)
├── .env.example            # Wzór zmiennych środowiskowych
├── docker-compose.yml      # PostGIS, FastAPI, OSRM, Planetiler i Caddy
├── init_db.sql             # Schemat bazy danych, relacje, indeksy GiST i unikalne ograniczenia
├── pyproject.toml          # Konfiguracja środowiska i zależności (uv)
└── README.md

```

## Stos technologiczny

* **Środowisko i język:** Python 3.14, menedżer pakietów [uv](https://docs.astral.sh/uv/)

* **Baza danych przestrzennych:** PostgreSQL 16 + PostGIS 3.4

* **Backend API:** FastAPI, Uvicorn, sterownik `psycopg` (binary z obsługą `COPY`)

* **Silnik routingu:** OSRM Backend (MLD)

* **Generowanie kafelków:** [Planetiler](https://github.com/onthegomap/planetiler) (Docker)

* **Format kafelków:** PMTiles (OpenMapTiles schema) oraz dynamiczne Mapbox Vector Tiles (MVT) generowane w locie przez `ST_AsMVT`

* **Frontend / Wizualizacja:** MapLibre GL JS, PMTiles Protocol, Caddy Server

* **Analiza i wizualizacja danych:** Pandas, NumPy, Plotly

* **Formaty danych:** NMEA 0183 (\$GPRMC,$GPGGA, $GPVTG,$GPGSA, $GPGSV,$GSENSORD), PBF (OpenStreetMap), GeoJSON

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

```

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

### 4. Przetwarzanie danych lokalizacyjnych (Python)

Umieść surowy plik z logami GPS w katalogu `data/raw.txt`, a następnie uruchom proces parsowania:

```
uv run src/parser.py

```

*Skrypt strumieniuje odczytane epoki bezpośrednio do bazy PostgreSQL/PostGIS, logując postęp przetwarzania w konsoli i aktualizując znacznik w `data/state.txt`.*

### 5. Dostęp do aplikacji

* **Główna mapa i planer trasy:**

  <http://localhost:8080/maps/tile_map.html>

* **Odtwarzacz trasy GPS (Playback & HUD):**

  <http://localhost:8080/maps/playback.html>

## Generowanie wykresów analitycznych

Aplikacja udostępnia skrypt do generowania interaktywnych wykresów w formacie HTML na podstawie danych telemetrycznych zgromadzonych w bazie:

1. **Uruchomienie skryptu:**

   ```
   uv run src/plots.py
   
   ```

   Wykresy zostaną zapisane w katalogu `plots/` (m.in. trójwymiarowy model przeciążeń z akcelerometru, skyplot satelitów GSV, histogramy prędkości i kursów, analiza parametrów DOP).

2. **Podgląd wykresów w przeglądarce (PowerShell):**

   ```
   Get-ChildItem -Path "plots\*.html" | ForEach-Object { Start-Process $_.FullName }
   
   ```

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
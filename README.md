
# NNAPER 🗺️

Aplikacja do przetwarzania danych lokalizacyjnych GPS w formacie **NMEA**, bezpośredniego strumieniowania ich do bazy danych **PostgreSQL + PostGIS** oraz wizualizacji na interaktywnej mapie opartej o kafelki wektorowe **PMTiles** (OpenStreetMap).

---

## Jak to działa?

1. **Infrastruktura kontenerowa (Docker Compose):**
   - W tle działa baza **PostgreSQL (PostGIS)** zainicjalizowana schematem z pliku `init_db.sql` oraz lekki serwer HTTP **Caddy** serwujący kafelki i mapę na porcie `8080`.

2. **Kafelki podkładowe OpenStreetMap (PMTiles):**
   - Profil narzędziowy w Dockerze weryfikuje obecność pliku `.osm.pbf` (w razie potrzeby pobiera go automatycznie z serwisu [Geofabrik](https://download.geofabrik.de/europe/poland.html)).
   - Narzędzie **Planetiler** kompresuje wyciąg OSM do pojedynczego pliku kafelków wektorowych `.pmtiles` w katalogu `geojsons/`.

3. **Parsowanie i strumieniowanie NMEA (`data/raw.txt`):**
   - Skrypt odczytuje surowe logi NMEA linia po linii, łącząc komunikaty w spójne epoki pomiarowe.
   - Dane są zapisywane partiami bezpośrednio do bazy PostgreSQL/PostGIS.
   - Unikalny indeks czasowy w bazie oraz plik `data/state.txt` zapobiegają duplikatom i pozwalają na bezpieczne wznawianie pracy w dowolnym momencie.

4. **Wizualizacja:**
   - Mapa w `maps/tile_map.html` odpytuje serwer o kafelki PMTiles i renderuje warstwy za pośrednictwem biblioteki **MapLibre GL JS**.

---

## Struktura projektu

```text
nnaper/
├── data/
│   ├── raw.txt             # Surowe logi NMEA z urządzenia GPS (nieśledzone w Git)
│   └── state.txt           # Numer ostatnio przetworzonej linii z raw.txt
├── geojsons/               # Dane przestrzenne i wyjściowe kafelki:
│   ├── *.osm.pbf           # Pobrany wyciąg OSM (np. pomorskie.osm.pbf, ignorowany w Git)
│   └── *.pmtiles           # Wygenerowane kafelki wektorowe PMTiles (ignorowane w Git)
├── maps/
│   └── tile_map.html       # Interfejs mapy (MapLibre GL JS)
├── src/
│   ├── constants.py        # Stałe konfiguracyjne i ścieżki projektu
│   ├── geography.py        # Narzędzia i funkcje pomocnicze do obliczeń geograficznych
│   ├── main.py             # Główny punkt startowy aplikacji
│   ├── map.py              # Tworzenie i konfiguracja mapy
│   ├── osm.py              # Ekstrakcja danych przestrzennych z plików PBF
│   ├── parser.py           # Parsowanie NMEA i zapis epok do PostgreSQL/PostGIS
│   └── utils.py            # Ogólne funkcje pomocnicze
├── .env.example            # Wzór zmiennych środowiskowych
├── docker-compose.yml      # Baza PostGIS, downloader PBF, Planetiler i serwer Caddy
├── init_db.sql             # Schemat bazy danych, relacje i unikalne indeksy
├── pyproject.toml          # Konfiguracja środowiska i zależności (uv)
└── README.md
```

---

## Stos technologiczny

- **Środowisko i język:** Python 3.14, menedżer pakietów [uv](https://docs.astral.sh/uv/)
- **Baza danych przestrzennych:** PostgreSQL 16 + PostGIS 3.4
- **Sterownik bazy danych:** `psycopg` (binary)
- **Generowanie kafelków:** [Planetiler](https://github.com/onthegomap/planetiler) (Docker)
- **Format kafelków:** PMTiles (OpenMapTiles schema)
- **Frontend / Wizualizacja:** MapLibre GL JS, Caddy Server
- **Formaty danych:** NMEA, PBF (OpenStreetMap), GeoJSON

---

## Wymagania wstępne

- Zainstalowany **Python 3.14+**
- Zainstalowane narzędzie **[uv](https://docs.astral.sh/uv/)**
- Zainstalowany **Docker Desktop** (wraz z obsługą Docker Compose)

---

## Konfiguracja i uruchomienie

### 1. Przygotowanie repozytorium
```bash
git clone https://github.com/Tryczyk/naper.git
cd naper
```

### 2. Konfiguracja zmiennych środowiskowych
Skopiuj wzorzec pliku konfiguracyjnego:
```bash
cp .env.example .env
```

W pliku `.env` wskaż nazwę pliku regionalnego OSM (domyślnie `pomorskie.osm.pbf`):
```env
OSM_FILE_NAME=pomorskie.osm.pbf
```

> **Uwaga:** Pliki `.pbf`, `.pmtiles`, wolumeny baz danych oraz duże pliki `data/raw.txt` są wykluczone z repozytorium Git przez `.gitignore`.

### 3. Uruchomienie infrastruktury (Docker Compose)
Uruchom bazę danych PostGIS oraz serwer plików w tle:
```bash
docker compose up -d
```
*Kontener bazy automatycznie utworzy tabele i indeksy na podstawie pliku `init_db.sql`.*

### 4. Generowanie kafelków wektorowych (.pmtiles)
Uruchom profil narzędziowy, który sprawdzi obecność pliku OSM (w razie potrzeby pobierze go z [Geofabrik](https://download.geofabrik.de/europe/poland.html)) i wygeneruje kafelki za pomocą Planetilera:
```bash
docker compose --profile tools run --rm tiles-generator
```

### 5. Przetwarzanie danych lokalizacyjnych (Python)
Umieść surowy plik z logami GPS w `data/raw.txt`, a następnie uruchom proces parsowania:
```bash
uv run src/main.py
```
*Skrypt strumieniuje odczytane epoki bezpośrednio do bazy PostgreSQL, logując postęp przetwarzania w konsoli i pliku `data/state.txt`.*

### 6. Podgląd mapy
Otwórz przeglądarkę pod adresem:
[http://localhost:8080/maps/tile_map.html](http://localhost:8080/maps/tile_map.html)
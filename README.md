<p align="center">
  <img src="assets/header.svg" alt="NNAPER Header" width="100%" />
</p>

# NNAPER - Telemetryczna Platforma GPS, Analizy Infrastruktury OSM i Zaawansowanego Routingu w Go & PostGIS

Wysokowydajna platforma do strumieniowego przetwarzania danych telemetrycznych GPS (NMEA, GPX, CSV), dociągania śladów do sieci dróg (**Map Matching OSRM**), wizualizacji infrastruktury drogowej i punktów POI z wyciągów `.osm.pbf`, eksploracji mapy (Heatmapa, Mgła Wojny, Rysowanie) oraz inteligentnego planowania i generowania tras.

Cały backend, lokalny geocoder, indeksator PBF oraz grafowy silnik wyznaczania tras zostały zrealizowane w **Go 1.24**, współpracując z przestrzenną bazą danych **PostgreSQL 16 + PostGIS 3.4**, silnikiem **OSRM**, wektorowym podkładem **PMTiles** (OpenStreetMap) oraz dynamicznym generowaniem kafelków wektorowych **MVT** (`ST_AsMVT`) bezpośrednio w locie.

---

## Główne możliwości platformy

### 1. Ultra-szybki silnik parsowania i Map Matchingu (Go)
* **Wydajność 15–30 MB/s**: Przetwarzanie plików o rozmiarach od kilkunastu kilobajtów do wielu gigabajtów (nawet 650 MB – 10 GB) ze znikomym zużyciem pamięci RAM (~25 MB).
* **Obsługiwane formaty**:
  * **NMEA 0183**: Pełna agregacja cykli `$GPRMC`, `$GPGGA`, `$GPGSV` (satelity) oraz `$GSENSORD` (trójosiowe przeciążenia akcelerometru $G_x$, $G_y$, $G_z$).
  * **GPX**: Ślady rejestrowane przez zegarki i aplikacje sportowe (Garmin, Strava, OsmAnd).
  * **CSV**: Elastyczne dopasowywanie kolumn (szerokość, długość, czas, prędkość, akceleracja).
* **Map Matching OSRM**: Równoległe (16 wątków) dopasowywanie punktów do sieci ulic z natychmiastową interpolacją wektorową geometrii dróg (`LINESTRING`) oraz filtrowaniem dryfu postojowego GPS.
* **Zadania w tle i trwałość**: Pełna asynchroniczność zadań na serwerze z zapisem stanu na dysku (`jobs_state.json`). Odświeżenie przeglądarki czy restart serwera nie gubi postępu ani importowanego pliku.

### 2. Dynamiczne kafelki wektorowe MVT (`/api/track/{z}/{x}/{y}.pbf`) i 3 tryby śladu
* Generowanie kafelków wektorowych bezpośrednio z PostGIS w czasie poniżej 10 milisekund za pomocą `ST_AsMVT` i `ST_TileEnvelope`.
* **Trzy tryby wizualizacji śladu**:
  * **Surowe punkty GPS (`raw`)**: Wyświetlanie pojedynczych epok pomiarowych z informacją o dacie, godzinie, prędkości i przeciążeniach.
  * **Dociągnięte do ulicy (`snapped`)**: Punkty zrzutowane na najbliższą oś jezdni.
  * **Zaznaczone ścieżki OSM (`osm`)**: Ciągłe, czyste wektory przejechanych odcinków ulic (`ST_LineMerge` z automatycznym odrzucaniem postojowego szumu GPS oraz płynną szerokością linii zależną od przybliżenia mapy).
* **Zaawansowany filtr czasu**: Jednoczesne filtrowanie po drzewie dat (`ROK -> MIESIĄC -> DZIEŃ`) oraz przedziale godzinowym (`CAŁA DOBA -> GODZINA -> 10 MINUT`).

### 3. Indeksator `.osm.pbf`, polskie znaki drogowe i punkty POI
* Automatyczne indeksowanie pliku `pomorskie-latest.osm.pbf` w tle przy pierwszym uruchomieniu serwera Go:
  * **Infrastruktura drogowa (`/api/infrastructure/{z}/{x}/{y}.pbf`)** z dedykowanymi ikonami znaków drogowych:
    * **Sygnalizacja drogowa**: Ikona sygnalizatora w stylu Apple Maps wraz z przestrzenną deduplikacją w PostGIS (1 ikona w geometrycznym środku skrzyżowania zamiast osobnych ikon dla każdej linii zatrzymania).
    * **Progi zwalniające**: Polski znak ostrzegawczy **A-11a** (`maps/icons/speed_bump.png`).
    * **Przejścia dla pieszych**: Polski znak informacyjny **D-6** (wektorowy SVG).
    * **Fotoradary**: Polski znak informacyjny **D-51** (wektorowy SVG).
    * **Odcinkowe pomiary prędkości (OPP)**: Wektorowa linia pomiarowa wraz ze znakami **D-51a** automatycznie umieszczanymi dokładnie na początku i końcu każdego odcinka pomiarowego.
  * **Kategorie punktów POI (`/api/poi/{z}/{x}/{y}.pbf` oraz `/api/poi/details`)**:
    * Miejsca kultu, Gastronomia, Opieka zdrowotna, Sklepy i usługi, Edukacja, Kultura, Transport i noclegi.
    * Kliknięcie w dowolny punkt POI lub znak infrastruktury otwiera kartę ze szczegółami (nazwa, adres, godziny otwarcia, telefon, strona WWW, operator, ograniczenie prędkości).
  * **Lokalny Geocoder 100% Offline (`/api/geocode/api`, `/api/geocode/reverse`)**: Błyskawiczne wyszukiwanie miast, ulic i numerów budynków oraz odwrotne geokodowanie bez zewnętrznych zapytań sieciowych.

### 4. Zaawansowany Planer i Inteligentny Generator Tras (`/api/route/plan`)
* **Silnik grafowy A* / Dijkstra w pamięci RAM (`329 360+` krawędzi dróg)**:
  * **Punkty unikania (strefy zakazu)**: Nielimitowana liczba punktów z indywidualnym promieniem w metrach (100% ominięcia wykluczonych stref lub tryb wysokiego kosztu).
  * **Unikanie autostrad i dróg szybkiego ruchu**: Przełącznik `Unikaj autostrad i dróg ekspresowych`.
  * **Suwaki unikania przeszkód (0..10 oraz tryb `MAX = 11 Minimum totalne`)**:
    * Progi zwalniające, Przejścia dla pieszych, Sygnalizacja świetlna, Ronda, Skrzyżowania.
    * Ustawienie suwaka na pozycję **MAX (Minimum totalne / unikaj zupełnie)** nakłada karę leksykograficzną `2 500 000` na pojedynczą przeszkodę, wymuszając znalezienie trasy z absolutnie minimalną możliwą liczbą przeszkód (np. 0 progów zwalniających, poza tymi niezbędnymi do wydostania się z zamkniętej strefy startowej/docelowej).
  * **Odkrywanie nowych dróg (`Preferuj nieodwiedzone drogi`)**: Wykorzystanie siatki przestrzennej dotychczasowych śladów użytkownika oraz procentowy wskaźnik nowych dróg na wyznaczonej trasie.
* **Inteligentny Generator Trasy Automatycznej (Auto-Route)**:
  * Generowanie spójnych pętli (powrót do startu) lub tras otwartych o zadanym dystansie w kilometrach z zakazem zawracania (U-turn) i weryfikacją silnej spójności węzłów (brak punktów w wodzie czy na izolowanych wyspach drogowych).
* **Algorytm 10 Znaczników Trasy + Eksport GPX 1:1**:
  * Automatyczne rozmieszczanie do **10 znaczników (punktów pośrednich)** tak daleko wzdłuż wyznaczonej trasy, jak to możliwe, dopóki standardowa najszybsza nawigacja (np. Google Maps) pokrywa się z wyznaczoną trasą; w miejscu, gdzie nawigacja wybrałaby inną drogę, stawiany jest kolejny znacznik korekcyjny.
  * Przycisk **Pobierz GPX (1:1)** umożliwiający pobranie pełnej geometrii wyznaczonej trasy (1:1 z każdym zakrętem) do aplikacji nawigacyjnych takich jak OsmAnd, Organic Maps, Garmin czy Strava.

### 5. Statystyki konta, 4 skrajne punkty geograficzne (N/S/E/W) i Presety warstw
* **Statystyki konta (`/api/stats`)**:
  * Obliczanie maksymalnej prędkości, łącznego przebiegu (km), unikalnych kilometrów dróg oraz zakresów geograficznych w czasie rzeczywistym.
  * **4 skrajne punkty na mapie (Północ N, Południe S, Wschód E, Zachód W)**: Automatyczne wyznaczanie i oznaczanie na mapie 4 skrajnych punktów, do których dotarł użytkownik, wraz z przyciskami natychmiastowego przelotu kamery do każdego z nich.
* **Presety warstw (`/api/presets`)**:
  * Wbudowane presety tematyczne (*Domyślny*, *Bezpieczeństwo i Fotoradary*, *Minimalistyczny*, *Eksploracja Miasta*) definiowane w `maps/layer-manager.js` oraz możliwość zapisywania własnych presetów kolorów i widoczności warstw na koncie użytkownika.
  * Ponowne wybranie aktywnego presetu z listy natychmiast przywraca jego oryginalne kolory i widoczność warstw.

### 6. Heatmapa, Mgła Wojny (Odkrywanie mapy) i Rysowanie po mapie
* **Heatmapa (`/api/heatmap/tiles/{z}/{x}/{y}.png`)**: Raster zagęszczenia przejazdów generowany dynamicznie z logarytmiczną skalą kolorystyczną (zielony -> żółty -> czerwony).
* **Odkrywanie mapy / Mgła Wojny (`/api/fog-of-war`)**: Podział obszaru na mikro-działki ograniczone siecią dróg, torów i rzek oraz trójkątną siatkę na terenach otwartych z licznikiem odkrytej powierzchni w $\text{km}^2$.
* **Rysowanie po mapie (`/api/drawings`)**: Pędzel swobodny, linie, wielokąty i notatki tekstowe przypisane do konta użytkownika.

### 7. Odtwarzacz trasy (Playback & HUD), Edytor epok i Eksport danych
* **Odtwarzacz trasy i Timelapse**: Animacja przejazdu z HUD prędkości, wysokości, przeciążeń 3D ($G_x, G_y, G_z$), wykresem przewyższeń, diagramem G-G oraz wizualizacją satelitów (Skyplot + orbita MEO).
* **Edycja punktów telemetrycznych**: Pojedyncze dodawanie/przesuwanie/usuwanie punktów oraz zaznaczanie ramką (`Box Select`) do masowego przesuwania lub usuwania.
* **Eksport danych**: Pobieranie tras w formatach **HTML (mapa offline)**, **PNG**, **SVG**, **GIF (animacja)**, **GPX**, **CSV**, **GeoJSON** oraz **KML**.

---

## Architektura i struktura projektu

```
nnaper/
├── assets/                  # Grafiki wektorowe nagłówka i zasoby statyczne
├── cmd/
│   └── nnaper-parser/       # Samodzielne narzędzie CLI parsera (nnaper-parser.exe)
├── data/                    # Dane lokalne, logi oraz INSTRUKCJA_DLA_TESTERA.md
├── internal/                # Pakiety domenowe serwera Go:
│   ├── auth/                # Autoryzacja, profile, presety warstw i statystyki konta (N/S/E/W)
│   ├── config/              # Konfiguracja środowiska (.env)
│   ├── dates/               # Hierarchiczne drzewo lat, miesięcy, dni oraz przedziałów godzinowych
│   ├── db/                  # Pula połączeń pgxpool PostgreSQL/PostGIS i migracje schematu
│   ├── epochs/              # Punkty telemetryczne, edycja batchowa, box-select, playback i timelapse
│   ├── export/              # Pobieranie i generowanie eksportu danych
│   ├── features/            # Heatmapa PNG, Mgła Wojny (Fog of War) i Rysowanie po mapie
│   ├── jobs/                # Menedżer asynchronicznych zadań w tle i recovery
│   ├── osm/                 # Indeksator .osm.pbf, kafelki MVT infrastruktury i POI, lokalny Geocoder
│   ├── parser/              # Silnik strumieniowego parsowania NMEA/GPX/CSV i Map Matchingu OSRM
│   ├── routing/             # Grafowy silnik wyznaczania tras, tryb MAX=11, auto-trasy i 10 znaczników
│   └── tiles/               # Dynamiczne kafelki wektorowe MVT śladów GPS (raw/snapped/osm) i cache
├── maps/                    # Statyczne pliki frontendu (HTML, CSS, JS):
│   ├── icons/               # Ikony znaków drogowych (m.in. speed_bump.png - A-11a)
│   ├── app.js               # Główna logika interfejsu mapy, filtr dat/czasu, popup POI, edytor epok
│   ├── auth-manager.js      # Panel konta, logowania, profili i 4 skrajnych punktów geograficznych
│   ├── export-manager.js    # Eksport tras (HTML, PNG, SVG, GIF, GPX, CSV, GeoJSON, KML)
│   ├── features-manager.js  # Obsługa Heatmapy, Mgły Wojny, Rysowania i Timelapse
│   ├── layer-manager.js     # Edytor kolorów warstw, widoczności i presetów
│   ├── layers.js            # Definicje warstw MapLibre, PMTiles oraz rejestracja ikon znaków (D-6, D-51, D-51a)
│   ├── map.html             # Główny widok aplikacji
│   ├── parser-manager.js    # Modal importu, upload i monitoring zadań z ETA
│   ├── playback-inline.js   # Odtwarzacz trasy (HUD, G-G diagram, profil wysokości, satelity)
│   ├── route-inline.js      # Planer i generator tras, suwaki przeszkód, eksport Google Maps i GPX 1:1
│   ├── runtime-config.js    # Konfiguracja endpointów API i OSRM
│   └── styles.css           # Stylizacja interfejsu
├── osm_data/                # Wyciągi OSM (.osm.pbf) i podkład wektorowy (.pmtiles)
├── osrm/                    # Profile routingu OSRM (car.lua)
├── tests/
│   └── run_tests.js         # Zestaw 27 grup testowych i 14 400+ przypadków brzegowych (Edge Cases)
├── docker-compose.yml       # Orkiestracja: PostGIS, Go API, OSRM, Planetiler, Caddy
├── Dockerfile               # Wielostopniowy build kontenera produkcyjnego Go
├── init_db.sql              # Inicjalizacja schematu bazy PostGIS i indeksów GiST
├── main.go                  # Główny punkt wejścia serwera Go (Chi router, port 8000)
└── README.md                # Dokumentacja techniczna platformy
```

---

## Uruchomienie aplikacji

### Uruchomienie pełnego środowiska w Dockerze (Zalecane)

Wszystkie usługi (PostGIS, Serwer Go, OSRM, Caddy) uruchamiane są poleceniem:

```powershell
docker compose up -d --build
```

Usługi są dostępne pod adresami:
* **Interfejs mapy i podkład wektorowy (Caddy)**: <http://localhost:8080/maps/map.html>
* **Bezpośredni serwer aplikacji i API (Go)**: <http://localhost:8000/maps/map.html>
* **Silnik nawigacji drogowej (OSRM)**: <http://localhost:5000>

---

## Automatyczne testy regresyjne i 14 400+ przypadków brzegowych

Projekt zawiera rozbudowany zestaw testów automatycznych w pliku [`tests/run_tests.js`](tests/run_tests.js), przeznaczony dla programistów i agentów AI w celu weryfikacji, że żadna zmiana nie psuje istniejących endpointów, kontraktów UI ani algorytmów geometrycznych i routingowych.

Uruchomienie pełnego zestawu testów:

```powershell
node tests/run_tests.js
```

Zakres weryfikacji obejmuje:
1. Walidację składni wszystkich modułów JavaScript oraz obecność warstw, ikon znaków drogowych (`D-6`, `A-11a`, `D-51`, `D-51a`, sygnalizacji świetlnej) i elementów interfejsu.
2. Testy integracyjne wszystkich endpointów REST API na żywo (`/api/health`, `/api/auth/*`, `/api/stats`, `/api/presets`, `/api/dates-tree`, `/api/time-tree`, `/api/track/*`, `/api/infrastructure/*`, `/api/poi/*`, `/api/poi/details`, `/api/geocode/*`, `/api/route/plan`, `/api/heatmap/*`, `/api/fog-of-war`, `/api/drawings`).
3. Weryfikację bazy PostGIS (przestrzenna deduplikacja sygnalizacji świetlnej oraz czystość geometrii śladów OSM).
4. Ponad **14 400 deterministycznych przypadków brzegowych (Edge Cases)**:
   * `2 600` testów parsera i generatora linków Google Maps (w tym odporność na uszkodzone URL, współrzędne poza zakresem, SQLi oraz XSS),
   * `3 000` testów funkcji kosztu routingu, unikania autostrad, stref wykluczonych oraz trybu `MAX = 11 (Minimum totalne)`,
   * `2 500` testów geometrii sferycznej, odległości punkt-łamana oraz pola powierzchni wielokątów i trójkątów Mgły Wojny,
   * `1 500` testów algorytmu zachłannego rozmieszczania do 10 znaczników wzdłuż wyznaczonej trasy,
   * `1 000` testów skali logarytmicznej Heatmapy.

Instrukcja pełnego przeklikania aplikacji oraz szczegółowa ankieta dla testera manualnego znajdują się w pliku [`data/INSTRUKCJA_DLA_TESTERA.md`](data/INSTRUKCJA_DLA_TESTERA.md).

---

## Licencja

Projekt objęty licencją MIT.

# NNAPER High-Performance GPS Parser (Go / Golang)

Nowoczesny, wysoce zoptymalizowany silnik parsowania i snapowania danych GPS do sieci drogowej OpenStreetMap przez OSRM dla projektu NNAPER.

## Główne cechy
- **Wielowątkowość OSRM (Goroutines):** Do 32 jednoczesnych połączeń HTTP Keep-Alive do OSRM.
- **Równoległe chunki `/match` i `/nearest`:** Eliminacja sekwencyjnego czekania na odpowiedzi serwera.
- **Spatial Cache w pamięci (`sync.Map`):** Punkty postojowe i powtarzające się współrzędne nie generują zbędnych zapytań HTTP.
- **Błyskawiczny zapis do PostgreSQL (`pgx`):** Bezpośredni binarny protokół `CopyFrom` z `synchronous_commit = 'OFF'`.
- **Obsługa formatów:**
  - NMEA / LOG (`$GPRMC`, `$GNRMC`, `$GPGGA`, `$GNGGA`, `$GPGSV`, `$GSENSORD` z przeciążeniami G-force).
  - GPX (strumieniowe czytanie XML).
  - CSV (automatyczne wykrywanie separatora `,` lub `;` oraz kolumn szerokości, długości, czasu i przeciążeń).
- **Protokół zdarzeń NDJSON:** Zgodny w 100% z interfejsem webowym NNAPER.

## Budowanie binarki

Wymagane środowisko: Go 1.21+

```bash
cd go-parser
go mod download
go build -o nnaper-parser.exe .
```

W systemie Linux / Docker:
```bash
CGO_ENABLED=0 go build -ldflags="-s -w" -o nnaper-parser .
```

## Uruchomienie z linii poleceń

```bash
nnaper-parser.exe -file C:/sync/raw.txt -profile-id "7a9f7e8a-1234-5678-9abc-def012345678" -snap=true
```

Dostępne parametry:
- `-file`: Ścieżka do pliku z danymi (wymagany)
- `-profile-id`: UUID profilu użytkownika
- `-db-url`: Connection string PostgreSQL (domyślnie z `DB_URL` w `.env`)
- `-osrm-url`: Adres serwera OSRM (domyślnie `http://localhost:5000`)
- `-snap`: Czy dociągać do dróg OSRM (domyślnie `true`)
- `-concurrency`: Liczba równoległych workerów OSRM (domyślnie `16`)
- `-chunk-size`: Rozmiar chunka OSRM (domyślnie `100`)
- `-json-progress`: Emisja zdarzeń NDJSON na stdout (domyślnie `true`)


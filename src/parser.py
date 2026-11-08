from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import http.client
import json
import math
import queue
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import psycopg

from constants import (
    BATCH_SIZE,
    DATA_FILE_PATH,
    DB_URL,
    DEFAULT_PROFILE_EMAIL_DOMAIN,
    DEFAULT_PROFILE_NAME,
    DEFAULT_PROFILE_PASSWORD_HASH,
    DEFAULT_PROFILE_USERNAME,
    MATCH_CHUNK_SIZE,
    MAX_SPEED_KMH,
    OSRM_URL,
    STATE_FILE_PATH,
)
from utils import ddm_to_dd, parse_nmea_time, to_int_or_none


def get_or_create_default_profile(
    cur,
    username=DEFAULT_PROFILE_USERNAME,
    profile_name=DEFAULT_PROFILE_NAME,
) -> str:
    cur.execute(
        """
        INSERT INTO users (username, email, password_hash)
        VALUES (%s, %s, %s)
        ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
        RETURNING user_id;
        """,
        (username, f"{username}@{DEFAULT_PROFILE_EMAIL_DOMAIN}", DEFAULT_PROFILE_PASSWORD_HASH),
    )
    user_id = cur.fetchone()[0]

    cur.execute(
        """
        INSERT INTO profiles (user_id, name)
        VALUES (%s, %s)
        ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING profile_id;
        """,
        (user_id, profile_name),
    )
    profile_id = str(cur.fetchone()[0])
    return profile_id


def to_float_or_none(v):
    if v is None:
        return None
    val = str(v).strip()
    if not val:
        return None
    try:
        return float(val)
    except ValueError:
        return None


def split_line(raw_line: str):
    return raw_line.split("*", 1)[0].split(",")


def get_part(parts, index):
    if index < len(parts) and parts[index]:
        return parts[index]
    return None


class RawEpoch:
    __slots__ = ['gsensord', 'gprmc', 'gpgga', 'gpgsvs']

    def __init__(self):
        self.gsensord = None
        self.gprmc = None
        self.gpgga = None
        self.gpgsvs = []


def haversine_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2.0) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0) ** 2
    return 6371000.0 * 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def resolve_and_qualify_epoch(
    epoch: RawEpoch,
    previous_point=None,
    last_known_date=None,
    max_speed_kmh: float = 1000.0,
):
    rmc_time, rmc_status, rmc_lat, rmc_lon, rmc_date, _ = epoch.gprmc or (None,) * 6
    gga_time, gga_lat, gga_lon, _, _, _ = epoch.gpgga or (None,) * 6

    # 1. Złożenie dokładnej daty oraz godziny (jeśli dostępne; brak czasu nie odrzuca punktu)
    chosen_time = rmc_time or gga_time
    chosen_date = rmc_date or last_known_date
    epoch_timestamp = None
    if chosen_date and chosen_time:
        epoch_timestamp = datetime.combine(chosen_date, chosen_time).replace(tzinfo=timezone.utc)

    # 2. Wybór współrzędnych - bez żadnych filtrów jakościowych (bierzemy dostępne współrzędne)
    chosen_lat = gga_lat if gga_lat is not None else rmc_lat
    chosen_lon = gga_lon if gga_lon is not None else rmc_lon

    if chosen_lat is None or chosen_lon is None:
        return None

    # 3. Wyznaczenie prędkości za każdym razem na bazie lat, lon, czas (o ile czas jest znany)
    speed_kmh = 0.0
    if previous_point is not None and epoch_timestamp is not None:
        previous_timestamp, previous_lat, previous_lon = previous_point
        if previous_timestamp is not None:
            elapsed_seconds = (epoch_timestamp - previous_timestamp).total_seconds()
            if elapsed_seconds <= 0:
                dist_meters = haversine_distance_meters(previous_lat, previous_lon, chosen_lat, chosen_lon)
                if dist_meters > 1.0:
                    speed_kmh = 999999.0
                else:
                    speed_kmh = 0.0
            else:
                dist_meters = haversine_distance_meters(previous_lat, previous_lon, chosen_lat, chosen_lon)
                speed_kmh = (dist_meters / elapsed_seconds) * 3.6

    # 4. Usunięcie punktów przekraczających próg prędkości (domyślnie 1000 km/h)
    if speed_kmh > max_speed_kmh:
        return None

    chosen_lat = round(chosen_lat, 6)
    chosen_lon = round(chosen_lon, 6)
    geom_wkt = f"SRID=4326;POINT({chosen_lon} {chosen_lat})"

    return chosen_lat, chosen_lon, geom_wkt, epoch_timestamp, round(speed_kmh, 2), chosen_date


class OSRMConnectionPool:
    """Wielowątkowa pula trwałych połączeń HTTP (Keep-Alive) do serwera OSRM."""
    def __init__(self, base_url: str = OSRM_URL, max_connections: int = 12, timeout: float = 4.0):
        self.base_url = base_url.rstrip("/")
        parsed = urllib.parse.urlparse(self.base_url)
        self.host = parsed.hostname or "localhost"
        self.port = parsed.port or (443 if parsed.scheme == "https" else 80)
        self.timeout = timeout
        self.max_connections = max_connections
        self.pool = queue.Queue(maxsize=max_connections)
        for _ in range(max_connections):
            self.pool.put(self._create_conn())

    def _create_conn(self):
        return http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)

    def close(self):
        while not self.pool.empty():
            try:
                conn = self.pool.get_nowait()
                conn.close()
            except Exception:
                pass

    def request_json(self, path: str):
        conn = self.pool.get()
        try:
            for attempt in range(2):
                try:
                    conn.request("GET", path, headers={"User-Agent": "nnaper-parser/1.0", "Accept": "application/json"})
                    resp = conn.getresponse()
                    body = resp.read().decode("utf-8")
                    if resp.status == 200:
                        try:
                            return 200, json.loads(body)
                        except Exception:
                            return 200, None
                    elif resp.status == 400:
                        try:
                            return 400, json.loads(body)
                        except Exception:
                            return 400, None
                    return resp.status, None
                except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, OSError):
                    try:
                        conn.close()
                    except Exception:
                        pass
                    conn = self._create_conn()
                    if attempt == 1:
                        raise
        finally:
            self.pool.put(conn)
        return 500, None

    def match(self, coords_list: list):
        coords_str = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in coords_list)
        radiuses_str = ";".join("30" for _ in coords_list)
        path = f"/match/v1/driving/{coords_str}?overview=false&geometries=geojson&gaps=ignore&tidy=true&radiuses={radiuses_str}"
        return self.request_json(path)

    def nearest(self, lon: float, lat: float):
        path = f"/nearest/v1/driving/{lon:.6f},{lat:.6f}?number=1"
        status, data = self.request_json(path)
        if status == 200 and data and data.get("code") == "Ok" and data.get("waypoints"):
            wp = data["waypoints"][0]
            dist = float(wp.get("distance", 9999.0))
            loc = wp.get("location")
            if loc and len(loc) == 2:
                return dist, loc
        return None, None

    def route(self, lon1: float, lat1: float, lon2: float, lat2: float):
        """Wyznacza drogę między dwoma punktami przez OSRM i zwraca jej dystans w metrach."""
        path = f"/route/v1/driving/{lon1:.6f},{lat1:.6f};{lon2:.6f},{lat2:.6f}?overview=false"
        status, data = self.request_json(path)
        if status == 200 and data and data.get("code") == "Ok" and data.get("routes"):
            route = data["routes"][0]
            return float(route.get("distance", 0.0))
        return None


# Globalna pula połączeń oraz in-memory cache dla współrzędnych (klucz: ~1m dokładności)
OSRM_POOL = None
GLOBAL_SNAP_CACHE = {}


def get_osrm_pool(osrm_url: str):
    global OSRM_POOL
    if OSRM_POOL is None or OSRM_POOL.base_url != osrm_url.rstrip("/"):
        OSRM_POOL = OSRMConnectionPool(base_url=osrm_url, max_connections=12)
    return OSRM_POOL


def get_snap_cache_key(lon: float, lat: float):
    return (round(lon, 5), round(lat, 5))


def run_map_matching_on_epochs(
    epochs: list,
    osrm_url: str = OSRM_URL,
    chunk_size: int = MATCH_CHUNK_SIZE,
):
    """
    Dociąganie punktów do sieci drogowej OSM:
    Każdy punkt ma mieć swój snapnięty odpowiednik (geom_snapped),
    nawet jeśli najbliższa droga znajduje się kilometr (lub więcej) dalej.
    """
    if not epochs:
        return

    pool = get_osrm_pool(osrm_url)

    # Krok 1: Błyskawiczne dopasowanie z in-memory cache dla znanych już współrzędnych
    for ep in epochs:
        key = get_snap_cache_key(ep["lon"], ep["lat"])
        if key in GLOBAL_SNAP_CACHE:
            ep["geom_snapped"] = GLOBAL_SNAP_CACHE[key]

    # Krok 2: Propagacja punktów postojowych (samochód stoi w miejscu < 3m i < 2 km/h)
    for i in range(1, len(epochs)):
        curr = epochs[i]
        prev = epochs[i - 1]
        if curr.get("geom_snapped") is not None:
            continue
        dist = haversine_distance_meters(prev["lat"], prev["lon"], curr["lat"], curr["lon"])
        if dist < 3.0 and (curr.get("speed_kmh", 0) < 2.0 or prev.get("speed_kmh", 0) < 2.0):
            if prev.get("geom_snapped") is not None:
                curr["geom_snapped"] = prev["geom_snapped"]
                GLOBAL_SNAP_CACHE[get_snap_cache_key(curr["lon"], curr["lat"])] = prev["geom_snapped"]

    # Krok 3: Podział na spójne segmenty czasowe (luki czasowe > 15s to osobne przejazdy)
    segments = []
    current_seg = [epochs[0]]
    for i in range(1, len(epochs)):
        curr_ep = epochs[i]
        prev_ep = epochs[i - 1]
        dt = (curr_ep["timestamp"] - prev_ep["timestamp"]).total_seconds() if curr_ep.get("timestamp") and prev_ep.get("timestamp") else 1.0
        if dt > 15.0 or dt < 0:
            segments.append(current_seg)
            current_seg = [curr_ep]
        else:
            current_seg.append(curr_ep)
    if current_seg:
        segments.append(current_seg)

    # Krok 4: Przetwarzanie segmentów przez OSRM Map Matching (/match)
    for seg in segments:
        unresolved_in_seg = [ep for ep in seg if ep.get("geom_snapped") is None]
        if not unresolved_in_seg:
            continue

        for start_idx in range(0, len(seg), chunk_size):
            chunk = seg[start_idx : start_idx + chunk_size]
            chunk_unresolved = [ep for ep in chunk if ep.get("geom_snapped") is None]
            if not chunk_unresolved:
                continue

            if len(chunk) >= 3:
                coords_list = [(ep["lon"], ep["lat"]) for ep in chunk]
                try:
                    status, data = pool.match(coords_list)
                    if status == 200 and data and data.get("code") == "Ok":
                        tracepoints = data.get("tracepoints", [])
                        for ep, tp in zip(chunk, tracepoints):
                            key = get_snap_cache_key(ep["lon"], ep["lat"])
                            if tp and isinstance(tp, dict):
                                loc = tp.get("location")
                                if loc and len(loc) == 2:
                                    snapped_wkt = f"SRID=4326;POINT({loc[0]:.6f} {loc[1]:.6f})"
                                    ep["geom_snapped"] = snapped_wkt
                                    GLOBAL_SNAP_CACHE[key] = snapped_wkt
                except Exception:
                    pass

    # Krok 5: Równoległe (wielowątkowe) dociąganie przez /nearest bez limitu odległości
    # (choćby najbliższa droga była kilometr lub dalej)
    to_query_nearest = []
    seen_in_batch = set()
    for ep in epochs:
        if ep.get("geom_snapped") is None:
            key = get_snap_cache_key(ep["lon"], ep["lat"])
            if key in GLOBAL_SNAP_CACHE:
                ep["geom_snapped"] = GLOBAL_SNAP_CACHE[key]
            elif key not in seen_in_batch:
                seen_in_batch.add(key)
                to_query_nearest.append((key, ep["lon"], ep["lat"]))

    if to_query_nearest:
        def fetch_nearest(item):
            k, lon, lat = item
            try:
                dist, loc = pool.nearest(lon, lat)
                if loc and len(loc) == 2:
                    return k, f"SRID=4326;POINT({loc[0]:.6f} {loc[1]:.6f})"
            except Exception:
                pass
            return k, None

        workers = min(12, max(2, len(to_query_nearest)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = executor.map(fetch_nearest, to_query_nearest)
            for k, snapped_wkt in results:
                if snapped_wkt:
                    GLOBAL_SNAP_CACHE[k] = snapped_wkt

        for ep in epochs:
            if ep.get("geom_snapped") is None:
                key = get_snap_cache_key(ep["lon"], ep["lat"])
                if key in GLOBAL_SNAP_CACHE:
                    ep["geom_snapped"] = GLOBAL_SNAP_CACHE[key]

    # Krok 6: Ostateczna gwarancja snapnięcia dla każdego punktu
    # Każdy punkt ma posiadać swój snapnięty odpowiednik (chociażby droga była daleko lub OSRM nie odpowiedział)
    for ep in epochs:
        if ep.get("geom_snapped") is None:
            ep["geom_snapped"] = ep["geom"]




class CopyBatchBuffer:
    def __init__(self, profile_id: str, previous_point=None):
        self.profile_id = profile_id
        self.batch_timestamps = set()
        self.epochs = []
        self.satellite = []
        self.last_point = previous_point
        self.last_timed_point = previous_point if (previous_point and previous_point[0] is not None) else None
        self.last_known_date = previous_point[0].date() if (previous_point and previous_point[0] is not None) else None

    def add_epoch(self, epoch: RawEpoch, last_known_date=None):
        date_to_use = last_known_date or self.last_known_date
        ref_point = self.last_timed_point or self.last_point
        result = resolve_and_qualify_epoch(
            epoch,
            previous_point=ref_point,
            last_known_date=date_to_use,
            max_speed_kmh=MAX_SPEED_KMH,
        )

        if result is None:
            return

        lat, lon, geom_wkt, epoch_ts, speed_kmh, chosen_date = result
        if chosen_date:
            self.last_known_date = chosen_date

        if epoch_ts is not None:
            epoch_key = (self.profile_id, epoch_ts)
            if epoch_key in self.batch_timestamps:
                return
            self.batch_timestamps.add(epoch_key)

        epoch_id = str(uuid.uuid4())

        self.epochs.append({
            "epoch_id": epoch_id,
            "profile_id": self.profile_id,
            "timestamp": epoch_ts,
            "geom": geom_wkt,
            "speed_kmh": round(speed_kmh, 2),
            "g_x": to_float_or_none(epoch.gsensord[0]) if epoch.gsensord else None,
            "g_y": to_float_or_none(epoch.gsensord[1]) if epoch.gsensord else None,
            "g_z": to_float_or_none(epoch.gsensord[2]) if epoch.gsensord else None,
            "lat": lat,
            "lon": lon,
            "geom_snapped": None,
        })
        self.last_point = (epoch_ts, lat, lon)
        if epoch_ts is not None:
            self.last_timed_point = (epoch_ts, lat, lon)

        if epoch.gpgsvs:
            for sats_list in epoch.gpgsvs:
                for sat in sats_list:
                    self.satellite.append((str(uuid.uuid4()), epoch_id, sat[0], sat[1], sat[2]))

    def flush(self, cur):
        if not self.epochs:
            return

        run_map_matching_on_epochs(
            self.epochs,
            osrm_url=OSRM_URL,
            chunk_size=MATCH_CHUNK_SIZE,
        )

        if not self.epochs:
            self.satellite.clear()
            self.batch_timestamps.clear()
            return

        cur.execute("""
            CREATE TEMP TABLE staging_epochs (
                LIKE epochs INCLUDING DEFAULTS
            ) ON COMMIT DROP;
        """)

        with cur.copy("""COPY staging_epochs (
            epoch_id, profile_id, timestamp, geom, speed_kmh, g_x, g_y, g_z, geom_snapped, geom_line
        ) FROM STDIN""") as copy:
            for ep in self.epochs:
                copy.write_row((
                    ep["epoch_id"],
                    ep["profile_id"],
                    ep["timestamp"],
                    ep["geom"],
                    ep["speed_kmh"],
                    ep["g_x"],
                    ep["g_y"],
                    ep["g_z"],
                    ep.get("geom_snapped"),
                    ep.get("geom_line"),
                ))

        if self.satellite:
            cur.execute("""
                CREATE TEMP TABLE staging_satellite (
                    LIKE satellite INCLUDING DEFAULTS
                ) ON COMMIT DROP;
            """)
            with cur.copy("COPY staging_satellite (satellite_id, epoch_id, prn, elevation, azimuth) FROM STDIN") as copy:
                for row in self.satellite:
                    copy.write_row(row)

        # Wstawienie epok z automatycznym i bezpiecznym pomijaniem duplikatów
        cur.execute("""
            INSERT INTO epochs (
                epoch_id, profile_id, timestamp, geom, speed_kmh, g_x, g_y, g_z, geom_snapped, geom_line
            )
            SELECT
                epoch_id, profile_id, timestamp, geom, speed_kmh, g_x, g_y, g_z, geom_snapped, geom_line
            FROM staging_epochs
            ON CONFLICT (profile_id, timestamp) DO UPDATE SET
                geom_snapped = EXCLUDED.geom_snapped,
                geom_line = EXCLUDED.geom_line;
        """)

        # Wstawienie satelitów tylko dla epok faktycznie zapisanych w bazie
        if self.satellite:
            cur.execute("""
                INSERT INTO satellite (satellite_id, epoch_id, prn, elevation, azimuth)
                SELECT s.satellite_id, s.epoch_id, s.prn, s.elevation, s.azimuth
                FROM staging_satellite s
                JOIN epochs e ON s.epoch_id = e.epoch_id;
            """)

        cur.execute("DROP TABLE IF EXISTS staging_satellite; DROP TABLE IF EXISTS staging_epochs;")

        self.epochs.clear()
        self.satellite.clear()
        self.batch_timestamps.clear()


def parse_data(data_file_path=DATA_FILE_PATH, batch_size=BATCH_SIZE):
    if not data_file_path.exists():
        print(f"Data file not found: {data_file_path}")
        return

    last_line_index = 0
    if STATE_FILE_PATH.exists():
        with open(STATE_FILE_PATH, "r") as f:
            c = f.read().strip()
            last_line_index = int(c) if c.isdigit() else 0

    total_bytes = data_file_path.stat().st_size if data_file_path.exists() else 0
    processed_bytes = 0
    initial_processed_bytes = 0
    t_start = time.time()

    print(f"Parsing from line: {last_line_index}")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SET synchronous_commit = OFF;")
            cur.execute("SET work_mem = '64MB';")

            cur.execute("ALTER TABLE epochs DROP COLUMN IF EXISTS altitude CASCADE;")
            cur.execute("ALTER TABLE epochs ALTER COLUMN timestamp DROP NOT NULL;")
            cur.execute("ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_snapped GEOMETRY(Point, 4326);")
            cur.execute("ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_line GEOMETRY(LineString, 4326);")
            cur.execute("ALTER TABLE epochs DROP COLUMN IF EXISTS geom_offroad CASCADE;")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);")
            cur.execute("DROP INDEX IF EXISTS idx_epochs_geom_offroad;")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom_line ON epochs USING GIST (geom_line);")
            conn.commit()

            profile_id = get_or_create_default_profile(cur)
            conn.commit()

            if last_line_index == 0:
                print("State is 0 — truncating tables...")
                cur.execute("TRUNCATE TABLE epochs CASCADE;")
                conn.commit()

            # Pobranie wyłącznie OSTATNIEGO punktu do haversine (zamiast całej bazy do RAM)
            cur.execute(
                """
                SELECT timestamp, ST_Y(geom), ST_X(geom)
                FROM epochs
                WHERE profile_id = %s
                ORDER BY timestamp DESC NULLS LAST
                LIMIT 1
                """,
                (profile_id,),
            )
            last_row = cur.fetchone()
            previous_point = None
            if last_row:
                previous_point = (
                    last_row[0],
                    float(last_row[1]),
                    float(last_row[2]),
                )

            last_known_date = previous_point[0].date() if (previous_point and previous_point[0] is not None) else None

            epoch = RawEpoch()
            epochs_in_batch = 0
            buffer = CopyBatchBuffer(
                profile_id=profile_id,
                previous_point=previous_point,
            )

            with open(str(data_file_path), "r", encoding="utf-8", errors="ignore") as data_file:
                for current_number, line in enumerate(data_file, start=1):
                    line_len = len(line.encode("utf-8", errors="ignore"))
                    processed_bytes += line_len

                    if current_number <= last_line_index:
                        continue

                    if initial_processed_bytes == 0 and last_line_index > 0:
                        initial_processed_bytes = processed_bytes
                        t_start = time.time()

                    raw_line = line.strip()
                    if not raw_line:
                        continue

                    parts = split_line(raw_line)
                    parts_count = len(parts)
                    tag = parts[0]

                    if tag == "$GSENSORD":
                        if epoch.gsensord:
                            buffer.add_epoch(epoch, last_known_date=last_known_date)
                            epochs_in_batch += 1
                            epoch = RawEpoch()
                        epoch.gsensord = (
                            get_part(parts, 1), get_part(parts, 2), get_part(parts, 3)
                        )

                    elif tag == "$GPRMC":
                        if epoch.gprmc:
                            buffer.add_epoch(epoch, last_known_date=last_known_date)
                            epochs_in_batch += 1
                            epoch = RawEpoch()

                        t_utc = get_part(parts, 1)
                        lat = ddm_to_dd(get_part(parts, 3), get_part(parts, 4))
                        lon = ddm_to_dd(get_part(parts, 5), get_part(parts, 6))
                        d_val = get_part(parts, 9)

                        parsed_time = None
                        parsed_date = None
                        if d_val and t_utc:
                            try:
                                dt = datetime.strptime(f"{d_val}{t_utc}", '%d%m%y%H%M%S.%f')
                                parsed_time = dt.time()
                                parsed_date = dt.date()
                            except ValueError:
                                pass
                        if not parsed_time and t_utc:
                            parsed_time = parse_nmea_time(t_utc)

                        if parsed_date:
                            last_known_date = parsed_date

                        epoch.gprmc = (
                            parsed_time, get_part(parts, 2), lat, lon, parsed_date, None
                        )

                    elif tag == "$GPGGA":
                        if epoch.gpgga:
                            buffer.add_epoch(epoch, last_known_date=last_known_date)
                            epochs_in_batch += 1
                            epoch = RawEpoch()

                        t_utc = get_part(parts, 1)
                        lat = ddm_to_dd(get_part(parts, 2), get_part(parts, 3))
                        lon = ddm_to_dd(get_part(parts, 4), get_part(parts, 5))

                        epoch.gpgga = (
                            parse_nmea_time(t_utc),
                            lat,
                            lon,
                            None,
                            None,
                            None,
                        )

                    elif tag == "$GPGSV":
                        tot_msg = to_int_or_none(get_part(parts, 1)) or 0
                        if epoch.gpgsvs and len(epoch.gpgsvs) == tot_msg:
                            buffer.add_epoch(epoch, last_known_date=last_known_date)
                            epochs_in_batch += 1
                            epoch = RawEpoch()

                        sats_list = []
                        s_idx = 4
                        while s_idx + 3 < parts_count:
                            sats_list.append((
                                to_int_or_none(get_part(parts, s_idx)),
                                to_int_or_none(get_part(parts, s_idx + 1)),
                                to_int_or_none(get_part(parts, s_idx + 2)),
                            ))
                            s_idx += 4

                        epoch.gpgsvs.append(sats_list)

                    if epochs_in_batch >= batch_size:
                        t_flush = time.time()
                        count = len(buffer.epochs)
                        buffer.flush(cur)
                        conn.commit()
                        flush_dt = time.time() - t_flush
                        speed = count / max(0.001, flush_dt)
                        epochs_in_batch = 0
                        with open(STATE_FILE_PATH, "w") as sf:
                            sf.write(str(current_number))

                        progress_pct = (processed_bytes / total_bytes * 100.0) if total_bytes > 0 else 0.0
                        elapsed_total = max(0.001, time.time() - t_start)
                        active_bytes = max(1, processed_bytes - initial_processed_bytes)
                        bytes_per_sec = active_bytes / elapsed_total
                        remaining_bytes = max(0, total_bytes - processed_bytes)
                        eta_seconds = remaining_bytes / max(1.0, bytes_per_sec)
                        eta_h = int(eta_seconds // 3600)
                        eta_m = int((eta_seconds % 3600) // 60)
                        eta_s = int(eta_seconds % 60)
                        eta_str = f"{eta_h:02d}:{eta_m:02d}:{eta_s:02d}"

                        print(
                            f"Parsed {current_number} lines ({count} epok w {flush_dt:.2f}s, "
                            f"{speed:.0f} epok/s, postęp: {progress_pct:.1f}%, ETA: {eta_str}, "
                            f"cache snap: {len(GLOBAL_SNAP_CACHE)})..."
                        )

                    last_line_index = current_number

            if epoch.gprmc or epoch.gpgga or epoch.gpgsvs or epoch.gsensord:
                buffer.add_epoch(epoch, last_known_date=last_known_date)

            buffer.flush(cur)
            conn.commit()
            with open(STATE_FILE_PATH, "w") as sf:
                sf.write(str(last_line_index))

    print(f"Parsing finished on line: {last_line_index}")


if __name__ == "__main__":
    parse_data()
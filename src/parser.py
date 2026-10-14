from datetime import datetime, timezone
import math
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
    MAX_HDOP,
    MAX_SPEED_KMH,
    PREFERRED_HDOP,
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


def resolve_and_qualify_epoch(
    epoch: RawEpoch,
    previous_point=None,
    max_hdop: float = MAX_HDOP,
    max_speed_kmh: float = MAX_SPEED_KMH,
):

    rmc_time, rmc_status, rmc_lat, rmc_lon, rmc_date = epoch.gprmc or (None,) * 5
    gga_time, gga_lat, gga_lon, gga_fix_q, gga_hdop, altitude = epoch.gpgga or (None,) * 6

    # 1. Złożenie i walidacja dokładnej daty oraz godziny
    chosen_time = rmc_time or gga_time
    epoch_timestamp = None
    if rmc_date and chosen_time:
        epoch_timestamp = datetime.combine(rmc_date, chosen_time).replace(tzinfo=timezone.utc)

    if epoch_timestamp is None:
        return None

    # 2. Walidacja statusu GPRMC
    if rmc_status is not None and rmc_status != 'A':
        return None

    # 3. Walidacja szerokości i długości geograficznej
    if rmc_lat is None and gga_lat is None:
        return None

    if rmc_lon is None and gga_lon is None:
        return None

    # 4. Walidacja jakości fixa i współczynnika HDOP
    if gga_fix_q is None or gga_fix_q <= 0:
        return None

    if gga_hdop is None or gga_hdop > max_hdop:
        return None

    # 5. Wybór optymalnej pozycji
    chosen_lat = None
    chosen_lon = None

    if gga_lat is not None and gga_lon is not None and (gga_fix_q and gga_fix_q > 0) and (gga_hdop is None or gga_hdop <= PREFERRED_HDOP):
        chosen_lat, chosen_lon = gga_lat, gga_lon
    elif rmc_lat is not None and rmc_lon is not None and rmc_status == 'A':
        chosen_lat, chosen_lon = rmc_lat, rmc_lon
    elif gga_lat is not None and gga_lon is not None:
        chosen_lat, chosen_lon = gga_lat, gga_lon
    elif rmc_lat is not None and rmc_lon is not None:
        chosen_lat, chosen_lon = rmc_lat, rmc_lon

    if chosen_lat is None or chosen_lon is None:
        return None

    speed_kmh = 0.0
    if previous_point is not None:
        previous_timestamp, previous_lat, previous_lon = previous_point
        elapsed_seconds = (epoch_timestamp - previous_timestamp).total_seconds()
        if elapsed_seconds <= 0:
            return None

        lat1 = math.radians(previous_lat)
        lat2 = math.radians(chosen_lat)
        delta_lat = math.radians(chosen_lat - previous_lat)
        delta_lon = math.radians(chosen_lon - previous_lon)
        haversine = (
            math.sin(delta_lat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
        )
        haversine = min(1.0, max(0.0, haversine))
        distance_km = 6371.0 * 2 * math.atan2(
            math.sqrt(haversine),
            math.sqrt(1.0 - haversine),
        )
        speed_kmh = distance_km / (elapsed_seconds / 3600.0)
        if speed_kmh > max_speed_kmh:
            return None

    chosen_lat = round(chosen_lat, 6)
    chosen_lon = round(chosen_lon, 6)
    geom_wkt = f"SRID=4326;POINT({chosen_lon} {chosen_lat})"

    return chosen_lat, chosen_lon, geom_wkt, epoch_timestamp, altitude, speed_kmh


class CopyBatchBuffer:
    def __init__(self, profile_id: str, existing_timestamps=(), previous_point=None):
        self.profile_id = profile_id
        self.seen_epoch_keys = {
            (profile_id, timestamp) for timestamp in existing_timestamps
        }
        self.epochs = []
        self.satellite = []
        self.last_point = previous_point

    def add_epoch(self, epoch: RawEpoch):
        result = resolve_and_qualify_epoch(epoch, previous_point=self.last_point)

        if result is None:
            return

        lat, lon, geom_wkt, epoch_ts, altitude, speed_kmh = result
        epoch_key = (self.profile_id, epoch_ts)
        if epoch_key in self.seen_epoch_keys:
            return

        self.seen_epoch_keys.add(epoch_key)
        epoch_id = str(uuid.uuid4())

        self.epochs.append((
            epoch_id,
            self.profile_id,
            epoch_ts,
            geom_wkt,
            altitude,
            round(speed_kmh, 2),
            to_float_or_none(epoch.gsensord[0]) if epoch.gsensord else None,
            to_float_or_none(epoch.gsensord[1]) if epoch.gsensord else None,
            to_float_or_none(epoch.gsensord[2]) if epoch.gsensord else None,
        ))
        self.last_point = (epoch_ts, lat, lon)

        if epoch.gpgsvs:
            for sats_list in epoch.gpgsvs:
                for sat in sats_list:
                    self.satellite.append((str(uuid.uuid4()), epoch_id, sat[0], sat[1], sat[2]))

    def flush(self, cur):
        if self.epochs:
            with cur.copy("""COPY epochs (
                epoch_id, profile_id, timestamp, geom, altitude, speed_kmh, g_x, g_y, g_z
            ) FROM STDIN""") as copy:
                for row in self.epochs:
                    copy.write_row(row)

        if self.satellite:
            with cur.copy("COPY satellite (satellite_id, epoch_id, prn, elevation, azimuth) FROM STDIN") as copy:
                for row in self.satellite:
                    copy.write_row(row)

        self.epochs.clear()
        self.satellite.clear()


def parse_data(data_file_path=DATA_FILE_PATH, batch_size=BATCH_SIZE):
    if not data_file_path.exists():
        print(f"Data file not found: {data_file_path}")
        return

    last_line_index = 0
    if STATE_FILE_PATH.exists():
        with open(STATE_FILE_PATH, "r") as f:
            c = f.read().strip()
            last_line_index = int(c) if c.isdigit() else 0

    print(f"Parsing from line: {last_line_index}")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SET synchronous_commit = OFF;")
            cur.execute("SET work_mem = '64MB';")

            profile_id = get_or_create_default_profile(cur)
            conn.commit()

            if last_line_index == 0:
                print("State is 0 — truncating tables...")
                cur.execute("TRUNCATE TABLE epochs CASCADE;")
                conn.commit()

            cur.execute(
                """
                SELECT timestamp, ST_Y(geom), ST_X(geom)
                FROM epochs
                WHERE profile_id = %s
                ORDER BY timestamp DESC
                """,
                (profile_id,),
            )
            existing_rows = cur.fetchall()
            existing_timestamps = [row[0] for row in existing_rows]
            previous_point = None
            if existing_rows:
                previous_point = (
                    existing_rows[0][0],
                    float(existing_rows[0][1]),
                    float(existing_rows[0][2]),
                )

            epoch = RawEpoch()
            epochs_in_batch = 0
            buffer = CopyBatchBuffer(
                profile_id=profile_id,
                existing_timestamps=existing_timestamps,
                previous_point=previous_point,
            )

            with open(str(data_file_path), "r", encoding="utf-8", errors="ignore") as data_file:
                for current_number, line in enumerate(data_file, start=1):
                    if current_number <= last_line_index:
                        continue

                    raw_line = line.strip()
                    if not raw_line:
                        continue

                    parts = split_line(raw_line)
                    parts_count = len(parts)
                    tag = parts[0]

                    if tag == "$GSENSORD":
                        if epoch.gsensord:
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = RawEpoch()
                        epoch.gsensord = (
                            get_part(parts, 1), get_part(parts, 2), get_part(parts, 3)
                        )

                    elif tag == "$GPRMC":
                        if epoch.gprmc:
                            buffer.add_epoch(epoch)
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

                        epoch.gprmc = (
                            parsed_time, get_part(parts, 2), lat, lon, parsed_date
                        )

                    elif tag == "$GPGGA":
                        if epoch.gpgga:
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = RawEpoch()

                        t_utc = get_part(parts, 1)
                        lat = ddm_to_dd(get_part(parts, 2), get_part(parts, 3))
                        lon = ddm_to_dd(get_part(parts, 4), get_part(parts, 5))

                        epoch.gpgga = (
                            parse_nmea_time(t_utc),
                            lat,
                            lon,
                            to_int_or_none(get_part(parts, 6)),
                            to_float_or_none(get_part(parts, 8)),
                            to_float_or_none(get_part(parts, 9)),
                        )

                    elif tag == "$GPGSV":
                        tot_msg = to_int_or_none(get_part(parts, 1)) or 0
                        if epoch.gpgsvs and len(epoch.gpgsvs) == tot_msg:
                            buffer.add_epoch(epoch)
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
                        buffer.flush(cur)
                        conn.commit()
                        epochs_in_batch = 0
                        with open(STATE_FILE_PATH, "w") as sf:
                            sf.write(str(current_number))
                        print(f"Parsed {current_number} lines.")

                    last_line_index = current_number

            if epoch.gprmc or epoch.gpgga or epoch.gpgsvs or epoch.gsensord:
                buffer.add_epoch(epoch)

            buffer.flush(cur)
            conn.commit()
            with open(STATE_FILE_PATH, "w") as sf:
                sf.write(str(last_line_index))

    print(f"Parsing finished on line: {last_line_index}")


if __name__ == "__main__":
    parse_data()
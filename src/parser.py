from datetime import datetime, timezone
import json
import math
from pathlib import Path
import uuid
import psycopg

from constants import DATA_FILE_PATH, STATE_FILE_PATH, DB_URL
from utils import ddm_to_dd, parse_nmea_time, to_int_or_none


def get_or_create_default_profile(cur, username="admin", profile_name="samochód") -> str:
    cur.execute(
        """
        INSERT INTO users (username, email, password_hash)
        VALUES (%s, %s, %s)
        ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
        RETURNING user_id;
        """,
        (username, f"{username}@local.dev", "placeholder_hash"),
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
    checksum = None
    cleaned = raw_line
    if "*" in raw_line:
        cleaned, checksum = raw_line.split("*", 1)
    parts = cleaned.split(",")
    return parts, checksum, len(parts)


def get_part(parts, index):
    if index < len(parts) and parts[index]:
        return parts[index]
    return None


class RawEpoch:
    __slots__ = ['terminator', 'gsensord', 'gprmc', 'gpvtg', 'gpgga', 'gpgsa', 'gpgsvs']

    def __init__(self):
        self.terminator = None
        self.gsensord = None
        self.gprmc = None
        self.gpvtg = None
        self.gpgga = None
        self.gpgsa = None
        self.gpgsvs = []


def resolve_and_qualify_epoch(
    epoch: RawEpoch,
    previous_point=None,
    max_hdop: float = 5.0,
    max_speed_kmh: float = 500.0,
):

    # Odczyt danych z GPRMC:
    # (s_raw, s_chk, s_cnt, time_val, status, lat, lat_hem, lon, lon_hem, spd, crs, date_val, mode)
    rmc_time = epoch.gprmc[3] if epoch.gprmc else None
    rmc_status = epoch.gprmc[4] if epoch.gprmc else None
    rmc_lat = epoch.gprmc[5] if epoch.gprmc else None
    rmc_lon = epoch.gprmc[7] if epoch.gprmc else None
    rmc_date = epoch.gprmc[11] if epoch.gprmc else None

    # Odczyt danych z GPGGA:
    # (s_raw, s_chk, s_cnt, gga_time, lat, lat_hem, lon, lon_hem, fix_q, sats_u, hdop, ...)
    gga_time = epoch.gpgga[3] if epoch.gpgga else None
    gga_lat = epoch.gpgga[4] if epoch.gpgga else None
    gga_lon = epoch.gpgga[6] if epoch.gpgga else None
    gga_fix_q = epoch.gpgga[8] if epoch.gpgga else None
    gga_hdop = epoch.gpgga[10] if epoch.gpgga else None

    # 1. Złożenie i walidacja dokładnej daty oraz godziny
    chosen_time = rmc_time or gga_time
    epoch_timestamp = None
    if rmc_date and chosen_time:
        epoch_timestamp = datetime.combine(rmc_date, chosen_time).replace(tzinfo=timezone.utc)

    if epoch_timestamp is None:
        return None

    # 2. Walidacja statusu GPRMC
    if epoch.gprmc and rmc_status != 'A':
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

    if gga_lat is not None and gga_lon is not None and (gga_fix_q and gga_fix_q > 0) and (gga_hdop is None or gga_hdop <= 3.0):
        chosen_lat, chosen_lon = gga_lat, gga_lon
    elif rmc_lat is not None and rmc_lon is not None and rmc_status == 'A':
        chosen_lat, chosen_lon = rmc_lat, rmc_lon
    elif gga_lat is not None and gga_lon is not None:
        chosen_lat, chosen_lon = gga_lat, gga_lon
    elif rmc_lat is not None and rmc_lon is not None:
        chosen_lat, chosen_lon = rmc_lat, rmc_lon

    if chosen_lat is None or chosen_lon is None:
        return None

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

    return chosen_lat, chosen_lon, geom_wkt, epoch_timestamp


class CopyBatchBuffer:
    def __init__(self, profile_id: str, existing_timestamps=()):
        self.profile_id = profile_id
        self.seen_epoch_keys = {
            (profile_id, timestamp) for timestamp in existing_timestamps
        }
        self.epochs = []
        self.sentences = []
        self.gsensord = []
        self.gprmc = []
        self.gpvtg = []
        self.gpgga = []
        self.gpgsa = []
        self.gpgsv = []
        self.satellite = []
        self.last_point = None

    def add_epoch(self, epoch: RawEpoch):
        result = resolve_and_qualify_epoch(epoch, previous_point=self.last_point)

        if result is None:
            return

        lat, lon, geom_wkt, epoch_ts = result
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
        ))
        self.last_point = (epoch_ts, lat, lon)

        if epoch.gsensord:
            s_raw, s_chk, s_cnt, gx, gy, gz = epoch.gsensord
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gsensord.append((s_id, gx, gy, gz))

        if epoch.gprmc:
            s_raw, s_chk, s_cnt, time_val, status, lat_v, lat_hem, lon_v, lon_hem, spd, crs, date_val, mode = epoch.gprmc
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gprmc.append((
                s_id, time_val, status, lat_v, lat_hem, lon_v, lon_hem, spd, crs, date_val, mode
            ))

        if epoch.gpvtg:
            s_raw, s_chk, s_cnt, c_true, c_ti, c_mag, c_mi, spd_kt, spd_kti, spd_km, spd_kmi, mode = epoch.gpvtg
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gpvtg.append((
                s_id, c_true, c_ti, c_mag, c_mi, spd_kt, spd_kti, spd_km, spd_kmi, mode
            ))

        if epoch.gpgga:
            s_raw, s_chk, s_cnt, gga_time, lat_v, lat_hem, lon_v, lon_hem, fix_q, sats_u, hdop, alt, alt_u, geo_sep, geo_sep_u, dgps_a, dgps_id = epoch.gpgga
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gpgga.append((
                s_id, gga_time, lat_v, lat_hem, lon_v, lon_hem, fix_q, sats_u, hdop,
                alt, alt_u, geo_sep, geo_sep_u, dgps_a, dgps_id
            ))

        if epoch.gpgsa:
            s_raw, s_chk, s_cnt, m1, m2, sats, pdop, hdop, vdop = epoch.gpgsa
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gpgsa.append((
                s_id, m1, m2, *sats, pdop, hdop, vdop
            ))

        if epoch.gpgsvs:
            for gsv_item in epoch.gpgsvs:
                s_raw, s_chk, s_cnt, tot_m, msg_n, sats_view, sats_list = gsv_item
                s_id = str(uuid.uuid4())
                self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
                
                self.gpgsv.append((s_id, tot_m, msg_n, sats_view))
                
                for sat in sats_list:
                    self.satellite.append((str(uuid.uuid4()), s_id, sat[0], sat[1], sat[2], sat[3]))

    def flush(self, cur):
        if self.epochs:
            with cur.copy("""COPY epochs (epoch_id, profile_id, timestamp, geom) FROM STDIN""") as copy:
                for row in self.epochs:
                    copy.write_row(row)

        if self.sentences:
            with cur.copy("COPY sentence (sentence_id, epoch_id, raw, checksum, parts_count) FROM STDIN") as copy:
                for row in self.sentences:
                    copy.write_row(row)

        if self.gsensord:
            with cur.copy("COPY gsensord (sentence_id, g_x, g_y, g_z) FROM STDIN") as copy:
                for row in self.gsensord:
                    copy.write_row(row)

        if self.gpvtg:
            with cur.copy("""COPY gpvtg (
                sentence_id, course_true, course_true_indicator, course_magnetic,
                course_magnetic_indicator, speed_knots, speed_knots_indicator,
                speed_kmh, speed_kmh_indicator, mode
            ) FROM STDIN""") as copy:
                for row in self.gpvtg:
                    copy.write_row(row)

        if self.gpgga:
            with cur.copy("""COPY gpgga (
                sentence_id, time_utc, latitude, latitude_hemisphere, longitude,
                longitude_hemisphere, fix_quality, satellites_used, hdop, altitude,
                altitude_units, geoid_separation, geoid_separation_units, dgps_age, dgps_station_id
            ) FROM STDIN""") as copy:
                for row in self.gpgga:
                    copy.write_row(row)

        if self.gpgsa:
            with cur.copy("""COPY gpgsa (
                sentence_id, mode1, mode2,
                satellite_1, satellite_2, satellite_3, satellite_4,
                satellite_5, satellite_6, satellite_7, satellite_8,
                satellite_9, satellite_10, satellite_11, satellite_12,
                pdop, hdop, vdop
            ) FROM STDIN""") as copy:
                for row in self.gpgsa:
                    copy.write_row(row)

        if self.gpgsv:
            with cur.copy("COPY gpgsv (sentence_id, total_messages, message_number, satellites_in_view) FROM STDIN") as copy:
                for row in self.gpgsv:
                    copy.write_row(row)

        if self.satellite:
            with cur.copy("COPY satellite (satellite_id, sentence_id, prn, elevation, azimuth, snr) FROM STDIN") as copy:
                for row in self.satellite:
                    copy.write_row(row)

        if self.gprmc:
            cur.execute("""
                CREATE TEMP TABLE temp_gprmc (
                    sentence_id UUID, time_utc TIME, status CHAR(1), latitude NUMERIC(10, 6),
                    latitude_hemisphere CHAR(1), longitude NUMERIC(11, 6), longitude_hemisphere CHAR(1),
                    speed_knots NUMERIC(6, 2), course NUMERIC(5, 2), date DATE, mode CHAR(1)
                ) ON COMMIT DROP;
            """)
            with cur.copy("""COPY temp_gprmc (
                sentence_id, time_utc, status, latitude, latitude_hemisphere,
                longitude, longitude_hemisphere, speed_knots, course, date, mode
            ) FROM STDIN""") as copy:
                for row in self.gprmc:
                    copy.write_row(row)

            cur.execute("""
                INSERT INTO gprmc (
                    sentence_id, time_utc, status, latitude, latitude_hemisphere,
                    longitude, longitude_hemisphere, speed_knots, course, date, mode
                )
                SELECT * FROM temp_gprmc
                ON CONFLICT (date, time_utc) DO NOTHING;
            """)
            cur.execute("DROP TABLE IF EXISTS temp_gprmc;")

        self.epochs.clear()
        self.sentences.clear()
        self.gsensord.clear()
        self.gprmc.clear()
        self.gpvtg.clear()
        self.gpgga.clear()
        self.gpgsa.clear()
        self.gpgsv.clear()
        self.satellite.clear()


def parse_data(data_file_path=DATA_FILE_PATH, batch_size=10000):
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

            profile_id = get_or_create_default_profile(cur, username="admin", profile_name="samochód")
            conn.commit()

            if last_line_index == 0:
                print("State is 0 — truncating tables...")
                cur.execute("TRUNCATE TABLE epochs CASCADE;")
                conn.commit()

            cur.execute(
                "SELECT timestamp FROM epochs WHERE profile_id = %s",
                (profile_id,),
            )
            existing_timestamps = [row[0] for row in cur.fetchall()]

            epoch = RawEpoch()
            epochs_in_batch = 0
            tag = ""
            buffer = CopyBatchBuffer(
                profile_id=profile_id,
                existing_timestamps=existing_timestamps,
            )

            with open(str(data_file_path), "r", encoding="utf-8", errors="ignore") as data_file:
                for current_number, line in enumerate(data_file, start=1):
                    if current_number <= last_line_index:
                        continue

                    raw_line = line.strip()
                    if not raw_line:
                        continue

                    parts, checksum, parts_count = split_line(raw_line)
                    tag = parts[0]

                    if tag == "$GSENSORD":
                        if epoch.gsensord:
                            epoch.terminator = tag
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = RawEpoch()
                        epoch.gsensord = (raw_line, checksum, parts_count,
                                          get_part(parts, 1), get_part(parts, 2), get_part(parts, 3))

                    elif tag == "$GPRMC":
                        if epoch.gprmc:
                            epoch.terminator = tag
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
                            raw_line, checksum, parts_count,
                            parsed_time, get_part(parts, 2), lat, get_part(parts, 4),
                            lon, get_part(parts, 6), get_part(parts, 7), get_part(parts, 8),
                            parsed_date, get_part(parts, 12)
                        )

                    elif tag == "$GPVTG":
                        if epoch.gpvtg:
                            epoch.terminator = tag
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = RawEpoch()
                        epoch.gpvtg = (
                            raw_line, checksum, parts_count,
                            get_part(parts, 1), get_part(parts, 2), get_part(parts, 3), get_part(parts, 4),
                            get_part(parts, 5), get_part(parts, 6), get_part(parts, 7), get_part(parts, 8),
                            get_part(parts, 9)
                        )

                    elif tag == "$GPGGA":
                        if epoch.gpgga:
                            epoch.terminator = tag
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = RawEpoch()

                        t_utc = get_part(parts, 1)
                        lat = ddm_to_dd(get_part(parts, 2), get_part(parts, 3))
                        lon = ddm_to_dd(get_part(parts, 4), get_part(parts, 5))

                        epoch.gpgga = (
                            raw_line, checksum, parts_count,
                            parse_nmea_time(t_utc), lat, get_part(parts, 3), lon, get_part(parts, 5),
                            to_int_or_none(get_part(parts, 6)), to_int_or_none(get_part(parts, 7)),
                            to_float_or_none(get_part(parts, 8)), to_float_or_none(get_part(parts, 9)),
                            get_part(parts, 10), to_float_or_none(get_part(parts, 11)), get_part(parts, 12),
                            to_float_or_none(get_part(parts, 13)), get_part(parts, 14)
                        )

                    elif tag == "$GPGSA":
                        if epoch.gpgsa:
                            epoch.terminator = tag
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = RawEpoch()

                        sats = [to_int_or_none(get_part(parts, i)) for i in range(3, 15)]
                        epoch.gpgsa = (
                            raw_line, checksum, parts_count,
                            get_part(parts, 1), to_int_or_none(get_part(parts, 2)),
                            sats, to_float_or_none(get_part(parts, 15)),
                            to_float_or_none(get_part(parts, 16)), to_float_or_none(get_part(parts, 17))
                        )

                    elif tag == "$GPGSV":
                        tot_msg = to_int_or_none(get_part(parts, 1)) or 0
                        if epoch.gpgsvs and len(epoch.gpgsvs) == tot_msg:
                            epoch.terminator = tag
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
                                to_int_or_none(get_part(parts, s_idx + 3))
                            ))
                            s_idx += 4

                        epoch.gpgsvs.append((
                            raw_line, checksum, parts_count,
                            tot_msg, to_int_or_none(get_part(parts, 2)),
                            to_int_or_none(get_part(parts, 3)), sats_list
                        ))

                    if epochs_in_batch >= batch_size:
                        buffer.flush(cur)
                        conn.commit()
                        epochs_in_batch = 0
                        with open(STATE_FILE_PATH, "w") as sf:
                            sf.write(str(current_number))
                        print(f"Parsed {current_number} lines.")

                    last_line_index = current_number

            if epoch.gprmc or epoch.gpgga or epoch.gpgsvs or epoch.gsensord or epoch.gpgsa:
                epoch.terminator = tag
                buffer.add_epoch(epoch)

            buffer.flush(cur)
            conn.commit()
            with open(STATE_FILE_PATH, "w") as sf:
                sf.write(str(last_line_index))

    print(f"Parsing finished on line: {last_line_index}")


if __name__ == "__main__":
    parse_data()
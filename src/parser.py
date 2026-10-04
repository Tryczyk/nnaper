from datetime import datetime
from pathlib import Path
import uuid
import psycopg

from constants import DATA_FILE_PATH, STATE_FILE_PATH
from utils import ddm_to_dd, parse_nmea_time, to_int_or_none

DB_URL = "postgresql://nnaper:nnaper@localhost:5432/nnaper_db"


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


class CopyBatchBuffer:
    def __init__(self):
        self.epochs = []
        self.sentences = []
        self.gsensord = []
        self.gprmc = []
        self.gpvtg = []
        self.gpgga = []
        self.gpgsa = []
        self.gpgsv = []
        self.satellite = []

    def add_epoch(self, epoch: RawEpoch):
        epoch_id = str(uuid.uuid4())
        self.epochs.append((epoch_id, epoch.terminator, None, None))

        if epoch.gsensord:
            s_raw, s_chk, s_cnt, gx, gy, gz = epoch.gsensord
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gsensord.append((s_id, gx, gy, gz))

        if epoch.gprmc:
            s_raw, s_chk, s_cnt, time_val, status, lat, lat_hem, lon, lon_hem, spd, crs, date_val, mode = epoch.gprmc
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gprmc.append((
                s_id, time_val, status, lat, lat_hem, lon, lon_hem, spd, crs, date_val, mode
            ))

        if epoch.gpvtg:
            s_raw, s_chk, s_cnt, c_true, c_ti, c_mag, c_mi, spd_kt, spd_kti, spd_km, spd_kmi, mode = epoch.gpvtg
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gpvtg.append((
                s_id, c_true, c_ti, c_mag, c_mi, spd_kt, spd_kti, spd_km, spd_kmi, mode
            ))

        if epoch.gpgga:
            s_raw, s_chk, s_cnt, gga_time, lat, lat_hem, lon, lon_hem, fix_q, sats_u, hdop, alt, alt_u, geo_sep, geo_sep_u, dgps_a, dgps_id = epoch.gpgga
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, s_raw, s_chk, s_cnt))
            self.gpgga.append((
                s_id, gga_time, lat, lat_hem, lon, lon_hem, fix_q, sats_u, hdop,
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
            with cur.copy("COPY epochs (epoch_id, terminator, time_diff, distance) FROM STDIN") as copy:
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

    epoch = RawEpoch()
    epochs_in_batch = 0
    tag = ""
    buffer = CopyBatchBuffer()

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SET synchronous_commit = OFF;")
            cur.execute("SET work_mem = '64MB';")

            if last_line_index == 0:
                print("State is 0 — truncating tables...")
                cur.execute("TRUNCATE TABLE epochs CASCADE;")
                conn.commit()

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
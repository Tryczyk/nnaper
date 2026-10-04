from datetime import datetime
from pathlib import Path
import uuid
import psycopg

from constants import DATA_FILE_PATH, STATE_FILE_PATH
from utils import ddm_to_dd, parse_nmea_time, to_int_or_none

DB_URL = "postgresql://nnaper:nnaper@localhost:5432/nnaper_db"


class Epoch:
    __slots__ = ['gsensord', 'gprmc', 'gpvtg', 'gpgga', 'gpgsa', 'gpgsvs', 'terminator', 'time_diff', 'distance']

    def __init__(self):
        self.gsensord = None
        self.gprmc = None
        self.gpvtg = None
        self.gpgga = None
        self.gpgsa = None
        self.gpgsvs = []
        self.terminator = None
        self.time_diff = None
        self.distance = None


class Sentence:
    __slots__ = ['raw', 'checksum', 'parts', 'parts_count']

    def __init__(self, raw=None):
        self.raw = raw
        self.checksum = None
        self.parts = []
        self.parts_count = 0

        if self.raw is None:
            return

        if "*" in self.raw:
            self.raw, self.checksum = self.raw.split("*", 1)

        self.parts = self.raw.split(",")
        self.parts_count = len(self.parts)

    def get_part(self, index):
        if index >= self.parts_count:
            return None
        value = self.parts[index]
        return value if value else None


class GSENSORD(Sentence):
    __slots__ = ['g_x', 'g_y', 'g_z']

    def __init__(self, raw=None):
        super().__init__(raw)
        self.g_x = self.get_part(1)
        self.g_y = self.get_part(2)
        self.g_z = self.get_part(3)


class GPRMC(Sentence):
    __slots__ = [
        'time_utc', 'status', 'latitude', 'latitude_hemisphere', 'longitude',
        'longitude_hemisphere', 'speed_knots', 'course', 'date',
        'magnetic_variation', 'magnetic_variation_hemisphere', 'mode', 'time'
    ]

    def __init__(self, raw=None):
        super().__init__(raw)
        self.time_utc = self.get_part(1)
        self.status = self.get_part(2)
        self.latitude = self.get_part(3)
        self.latitude_hemisphere = self.get_part(4)
        self.longitude = self.get_part(5)
        self.longitude_hemisphere = self.get_part(6)
        self.speed_knots = self.get_part(7)
        self.course = self.get_part(8)
        self.date = self.get_part(9)
        self.magnetic_variation = self.get_part(10)
        self.magnetic_variation_hemisphere = self.get_part(11)
        self.mode = self.get_part(12)

        self.latitude = ddm_to_dd(self.latitude, self.latitude_hemisphere)
        self.longitude = ddm_to_dd(self.longitude, self.longitude_hemisphere)

        if self.date is not None and self.time_utc is not None:
            try:
                self.time = datetime.strptime(f"{self.date}{self.time_utc}", '%d%m%y%H%M%S.%f')
            except ValueError:
                self.time = None
        else:
            self.time = None


class GPVTG(Sentence):
    __slots__ = [
        'course_true', 'course_true_indicator', 'course_magnetic',
        'course_magnetic_indicator', 'speed_knots', 'speed_knots_indicator',
        'speed_kmh', 'speed_kmh_indicator', 'mode'
    ]

    def __init__(self, raw=None):
        super().__init__(raw)
        self.course_true = self.get_part(1)
        self.course_true_indicator = self.get_part(2)
        self.course_magnetic = self.get_part(3)
        self.course_magnetic_indicator = self.get_part(4)
        self.speed_knots = self.get_part(5)
        self.speed_knots_indicator = self.get_part(6)
        self.speed_kmh = self.get_part(7)
        self.speed_kmh_indicator = self.get_part(8)
        self.mode = self.get_part(9)


class GPGGA(Sentence):
    __slots__ = [
        'time_utc', 'latitude', 'latitude_hemisphere', 'longitude',
        'longitude_hemisphere', 'fix_quality', 'satellites_used', 'hdop',
        'altitude', 'altitude_units', 'geoid_separation', 'geoid_separation_units',
        'dgps_age', 'dgps_station_id'
    ]

    def __init__(self, raw=None):
        super().__init__(raw)
        self.time_utc = self.get_part(1)
        self.latitude = self.get_part(2)
        self.latitude_hemisphere = self.get_part(3)
        self.longitude = self.get_part(4)
        self.longitude_hemisphere = self.get_part(5)
        self.fix_quality = self.get_part(6)
        self.satellites_used = self.get_part(7)
        self.hdop = self.get_part(8)
        self.altitude = self.get_part(9)
        self.altitude_units = self.get_part(10)
        self.geoid_separation = self.get_part(11)
        self.geoid_separation_units = self.get_part(12)
        self.dgps_age = self.get_part(13)
        self.dgps_station_id = self.get_part(14)
        self.latitude = ddm_to_dd(self.latitude, self.latitude_hemisphere)
        self.longitude = ddm_to_dd(self.longitude, self.longitude_hemisphere)


class GPGSA(Sentence):
    __slots__ = ['mode1', 'mode2', 'satellites', 'pdop', 'hdop', 'vdop']

    def __init__(self, raw=None):
        super().__init__(raw)
        self.mode1 = self.get_part(1)
        self.mode2 = to_int_or_none(self.get_part(2))
        self.satellites = [to_int_or_none(self.get_part(i)) for i in range(3, 15)]
        self.pdop = self.get_part(15)
        self.hdop = self.get_part(16)
        self.vdop = self.get_part(17)


class GPGSV(Sentence):
    __slots__ = ['total_messages', 'message_number', 'satellites_in_view', 'satellites']

    def __init__(self, raw=None):
        super().__init__(raw)
        self.total_messages = self.get_part(1)
        self.message_number = self.get_part(2)
        self.satellites_in_view = self.get_part(3)
        self.satellites = []

        satellite_index = 4
        while satellite_index + 3 < self.parts_count:
            self.satellites.append(Satellite(
                prn=self.get_part(satellite_index),
                elevation=self.get_part(satellite_index + 1),
                azimuth=self.get_part(satellite_index + 2),
                snr=self.get_part(satellite_index + 3),
            ))
            satellite_index += 4


class Satellite:
    __slots__ = ['prn', 'elevation', 'azimuth', 'snr']

    def __init__(self, prn=None, elevation=None, azimuth=None, snr=None):
        self.prn = prn
        self.elevation = elevation
        self.azimuth = azimuth
        self.snr = snr


TAG_CLASSES = {
    "$GSENSORD": GSENSORD,
    "$GPRMC": GPRMC,
    "$GPVTG": GPVTG,
    "$GPGGA": GPGGA,
    "$GPGSA": GPGSA,
}


def where_did_we_stop(state_file_path=STATE_FILE_PATH):
    if state_file_path.exists():
        with open(state_file_path, "r") as f:
            content = f.read().strip()
            return int(content) if content.isdigit() else 0
    return 0


def to_float_or_none(v):
    try:
        return float(v) if v is not None and str(v).strip() != "" else None
    except ValueError:
        return None


class BatchBuffer:
    """Buforuje rekordy w pamięci, aby wysyłać je hurtowo za pomocą executemany."""
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

    def add_epoch(self, epoch):
        epoch_id = str(uuid.uuid4())
        self.epochs.append((epoch_id, epoch.terminator, None, None))

        if epoch.gsensord:
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, epoch.gsensord.raw, epoch.gsensord.checksum, epoch.gsensord.parts_count))
            self.gsensord.append((s_id, epoch.gsensord.g_x, epoch.gsensord.g_y, epoch.gsensord.g_z))

        if epoch.gprmc:
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, epoch.gprmc.raw, epoch.gprmc.checksum, epoch.gprmc.parts_count))
            gprmc_time = epoch.gprmc.time.time() if epoch.gprmc.time else parse_nmea_time(epoch.gprmc.time_utc)
            gprmc_date = epoch.gprmc.time.date() if epoch.gprmc.time else None
            self.gprmc.append((
                s_id, gprmc_time, epoch.gprmc.status, epoch.gprmc.latitude,
                epoch.gprmc.latitude_hemisphere, epoch.gprmc.longitude,
                epoch.gprmc.longitude_hemisphere, epoch.gprmc.speed_knots,
                epoch.gprmc.course, gprmc_date, epoch.gprmc.mode
            ))

        if epoch.gpvtg:
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, epoch.gpvtg.raw, epoch.gpvtg.checksum, epoch.gpvtg.parts_count))
            self.gpvtg.append((
                s_id, epoch.gpvtg.course_true, epoch.gpvtg.course_true_indicator,
                epoch.gpvtg.course_magnetic, epoch.gpvtg.course_magnetic_indicator,
                epoch.gpvtg.speed_knots, epoch.gpvtg.speed_knots_indicator,
                epoch.gpvtg.speed_kmh, epoch.gpvtg.speed_kmh_indicator, epoch.gpvtg.mode
            ))

        if epoch.gpgga:
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, epoch.gpgga.raw, epoch.gpgga.checksum, epoch.gpgga.parts_count))
            gga_time = parse_nmea_time(epoch.gpgga.time_utc)
            self.gpgga.append((
                s_id, gga_time, epoch.gpgga.latitude, epoch.gpgga.latitude_hemisphere,
                epoch.gpgga.longitude, epoch.gpgga.longitude_hemisphere, epoch.gpgga.fix_quality,
                epoch.gpgga.satellites_used, epoch.gpgga.hdop, epoch.gpgga.altitude,
                epoch.gpgga.altitude_units, epoch.gpgga.geoid_separation,
                epoch.gpgga.geoid_separation_units, epoch.gpgga.dgps_age, epoch.gpgga.dgps_station_id
            ))

        if epoch.gpgsa:
            s_id = str(uuid.uuid4())
            self.sentences.append((s_id, epoch_id, epoch.gpgsa.raw, epoch.gpgsa.checksum, epoch.gpgsa.parts_count))
            sats = getattr(epoch.gpgsa, "satellites", []) or []
            sats_padded = [to_int_or_none(sats[i]) if i < len(sats) else None for i in range(12)]
            self.gpgsa.append((
                s_id, epoch.gpgsa.mode1, to_int_or_none(epoch.gpgsa.mode2),
                *sats_padded,
                to_float_or_none(epoch.gpgsa.pdop),
                to_float_or_none(epoch.gpgsa.hdop),
                to_float_or_none(epoch.gpgsa.vdop)
            ))

        if epoch.gpgsvs:
            for gsv in epoch.gpgsvs:
                gsv_id = str(uuid.uuid4())
                self.sentences.append((gsv_id, epoch_id, gsv.raw, gsv.checksum, gsv.parts_count))
                self.gpgsv.append((gsv_id, gsv.total_messages, gsv.message_number, gsv.satellites_in_view))
                if gsv.satellites:
                    for s in gsv.satellites:
                        self.satellite.append((str(uuid.uuid4()), gsv_id, s.prn, s.elevation, s.azimuth, s.snr))

    def flush(self, cursor):
        """Wrzuca wszystkie zebrane dane jednym zbiorczym executemany dla każdej tabeli."""
        if self.epochs:
            cursor.executemany("INSERT INTO epochs (epoch_id, terminator, time_diff, distance) VALUES (%s, %s, %s, %s)", self.epochs)
        if self.sentences:
            cursor.executemany("INSERT INTO sentence (sentence_id, epoch_id, raw, checksum, parts_count) VALUES (%s, %s, %s, %s, %s)", self.sentences)
        if self.gsensord:
            cursor.executemany("INSERT INTO gsensord (sentence_id, g_x, g_y, g_z) VALUES (%s, %s, %s, %s)", self.gsensord)
        if self.gprmc:
            cursor.executemany("""
                INSERT INTO gprmc (
                    sentence_id, time_utc, status, latitude, latitude_hemisphere,
                    longitude, longitude_hemisphere, speed_knots, course, date, mode
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (date, time_utc) DO NOTHING
            """, self.gprmc)
        if self.gpvtg:
            cursor.executemany("""
                INSERT INTO gpvtg (
                    sentence_id, course_true, course_true_indicator, course_magnetic,
                    course_magnetic_indicator, speed_knots, speed_knots_indicator,
                    speed_kmh, speed_kmh_indicator, mode
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, self.gpvtg)
        if self.gpgga:
            cursor.executemany("""
                INSERT INTO gpgga (
                    sentence_id, time_utc, latitude, latitude_hemisphere, longitude,
                    longitude_hemisphere, fix_quality, satellites_used, hdop, altitude,
                    altitude_units, geoid_separation, geoid_separation_units, dgps_age, dgps_station_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, self.gpgga)
        if self.gpgsa:
            cursor.executemany("""
                INSERT INTO gpgsa (
                    sentence_id, mode1, mode2,
                    satellite_1, satellite_2, satellite_3, satellite_4,
                    satellite_5, satellite_6, satellite_7, satellite_8,
                    satellite_9, satellite_10, satellite_11, satellite_12,
                    pdop, hdop, vdop
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, self.gpgsa)
        if self.gpgsv:
            cursor.executemany("INSERT INTO gpgsv (sentence_id, total_messages, message_number, satellites_in_view) VALUES (%s, %s, %s, %s)", self.gpgsv)
        if self.satellite:
            cursor.executemany("INSERT INTO satellite (satellite_id, sentence_id, prn, elevation, azimuth, snr) VALUES (%s, %s, %s, %s, %s, %s)", self.satellite)

        # Wyczyszczenie list po zrzucie
        self.epochs.clear()
        self.sentences.clear()
        self.gsensord.clear()
        self.gprmc.clear()
        self.gpvtg.clear()
        self.gpgga.clear()
        self.gpgsa.clear()
        self.gpgsv.clear()
        self.satellite.clear()


def parse_data(data_file_path=DATA_FILE_PATH, batch_size=5000):
    if not data_file_path.exists():
        print(f"Nie znaleziono pliku: {data_file_path}")
        return

    last_line_index = where_did_we_stop()
    print(f"Parsing from line: {last_line_index}")

    epoch = Epoch()
    epochs_in_batch = 0
    tag = ""
    buffer = BatchBuffer()

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            # 5. Tuning sesji PostgreSQL pod kątem szybkiego masowego importu
            cur.execute("SET synchronous_commit = OFF;")
            cur.execute("SET work_mem = '64MB';")

            if last_line_index == 0:
                print("Stan wynosi 0 — czyszczenie bazy...")
                cur.execute("TRUNCATE TABLE epochs CASCADE;")
                conn.commit()

            with open(str(data_file_path), "r", encoding="utf-8", errors="ignore") as data_file:
                for current_number, line in enumerate(data_file, start=1):
                    if current_number <= last_line_index:
                        continue

                    line = line.strip()
                    if not line:
                        continue

                    parts = line.split(",")
                    tag = parts[0]

                    if tag in TAG_CLASSES:
                        sentence_class = TAG_CLASSES[tag]
                        field_name = sentence_class.__name__.lower()

                        if getattr(epoch, field_name):
                            epoch.terminator = tag
                            buffer.add_epoch(epoch)
                            epochs_in_batch += 1
                            epoch = Epoch()

                        setattr(epoch, field_name, sentence_class(line))

                    elif tag == "$GPGSV":
                        if epoch.gpgsvs:
                            max_gpgsv = int(epoch.gpgsvs[0].total_messages or 0)
                            if max_gpgsv == len(epoch.gpgsvs):
                                epoch.terminator = tag
                                buffer.add_epoch(epoch)
                                epochs_in_batch += 1
                                epoch = Epoch()

                        epoch.gpgsvs.append(GPGSV(line))

                    if epochs_in_batch >= batch_size:
                        buffer.flush(cur)
                        conn.commit()
                        epochs_in_batch = 0
                        with open(STATE_FILE_PATH, "w") as sf:
                            sf.write(str(current_number))
                        print(f"Parsed {current_number} lines.")

                    last_line_index = current_number

            # Dopisanie ostatniej niedomkniętej epoki
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
from pathlib import Path
import pickle
from datetime import datetime
from operator import attrgetter

import geopandas as gpd
from shapely.geometry import Point

import pandas as pd

from constants import DATA_FILE_PATH, ENGINE_OFF_THRESHOLD, EPOCHS_FILE_PATH, PARSING_ENABLED, STATE_FILE_PATH
from geography import ddm_to_dd, haversine_vec
from utils import count_lines

class Epoch():
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

class Sentence():
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
    __slots__ = ['time_utc', 'status', 'latitude', 'latitude_hemisphere', 'longitude', 
                 'longitude_hemisphere', 'speed_knots', 'course', 'date', 
                 'magnetic_variation', 'magnetic_variation_hemisphere', 'mode', 'time']
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
        self.latitude = ddm_to_dd(self.latitude, self.latitude_hemisphere) #TODO zmienic to zeby nie nadpisywalo zmiennej
        self.longitude = ddm_to_dd(self.longitude, self.longitude_hemisphere)
        if self.date is not None and self.time_utc is not None:
            self.time = datetime.strptime(f"{self.date}{self.time_utc}", '%d%m%y%H%M%S.%f')
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
        self.mode2 = self.get_part(2)
        self.satellites = [self.get_part(index) for index in range(3, 15)]
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

class Satellite():
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

def where_did_we_stop(state_file_path = STATE_FILE_PATH,):
    if state_file_path.exists():
        with open(state_file_path, "r") as f:
            return int(f.read().strip()) 
    else:
        print(f"Failed to open {state_file_path}!")
        return 0

def load_epochs(epochs_file_path = EPOCHS_FILE_PATH):
    if epochs_file_path.exists():
        with open(epochs_file_path, "rb") as file:
            return pickle.load(file)    
    else:
        print(f"Failed to open {str(epochs_file_path)}!")
        return []

def save_epochs(last_line_index, original_last_line_index, epochs, epochs_file_path = EPOCHS_FILE_PATH, state_file_path = STATE_FILE_PATH,):
    if last_line_index != original_last_line_index:
        with open(epochs_file_path, "wb") as file:
            pickle.dump(epochs, file, protocol=pickle.HIGHEST_PROTOCOL)

        with open(state_file_path, "w") as f:
            f.write(str(last_line_index))

def epochs_to_df(epochs):
    return pd.DataFrame([
        {
            "time": p.gprmc.time,
            "lon": p.gprmc.longitude,
            "lat": p.gprmc.latitude
        } for p in epochs if p.gprmc is not None and p.gprmc.latitude is not None and p.gprmc.longitude is not None
    ])

def parse_data(
    data_file_path = DATA_FILE_PATH,
    tag_classes = TAG_CLASSES,
    engine_off_treshold = ENGINE_OFF_THRESHOLD,
    epochs_file_path = EPOCHS_FILE_PATH
    ):


    if not data_file_path.exists():
        print("Failed to find data file!")
        return
    
    last_line_index = where_did_we_stop()

    if count_lines(data_file_path) == last_line_index and epochs_file_path.exists() and Path("geojsons/driven.geojson").exists():
        print("No parsing was needed!")
        return

    original_last_line_index = last_line_index

    epochs = []

    if last_line_index != 0:
        epochs = load_epochs()

    epoch = Epoch()
    tag = ""

    with open(str(data_file_path), "r") as data_file:
        for current_number, line in enumerate(data_file, start=1):
            
            if current_number <= last_line_index:
                continue

            line = line.strip()

            if not line:
                continue

            parts = line.split(",")
            tag = parts[0]

            if tag in tag_classes:
                sentence_class = tag_classes[tag]
                field_name = sentence_class.__name__.lower()

                if getattr(epoch, field_name):
                    epoch.terminator = tag
                    epochs.append(epoch)
                    epoch = Epoch()
                setattr(epoch, field_name, sentence_class(line))

            elif tag == "$GPGSV":
                if epoch.gpgsvs:
                    max_gpgsv = int(epoch.gpgsvs[0].total_messages)
                    gpgsv_len = len(epoch.gpgsvs)
                    if max_gpgsv == gpgsv_len:
                        epoch.terminator = tag
                        epochs.append(epoch)
                        epoch = Epoch()

                epoch.gpgsvs.append(GPGSV(line))
            last_line_index = current_number

    if (epoch.gprmc is not None or epoch.gpgga is not None or
    epoch.gpgsvs or epoch.gsensord is not None or epoch.gpgsa is not None):
        epoch.terminator = tag
        epochs.append(epoch)

    print(f"Original Epochs amount: {len(epochs)}.")
    epochs = [e for e in epochs if e.gprmc is not None and e.gprmc.time is not None]
    print(f"Epochs amount after removing data with no timestamps: {len(epochs)}.")

    seen = set()
    unique_epochs = []
    for item in epochs:
        if item is not None and getattr(item, 'gprmc', None) is not None:
            identifier = item.gprmc.time
        else:
            identifier = id(item) 
        if identifier not in seen:
            seen.add(identifier)
            unique_epochs.append(item)
    epochs = unique_epochs

    print(f"Epochs amount after removing duplicates: {len(epochs)}.")

    epochs.sort(key=attrgetter("gprmc.time"))

    save_epochs(last_line_index, original_last_line_index, epochs)

    df = epochs_to_df(epochs)

    df = df.sort_values(by="time").reset_index(drop=True)
    df['time_diff'] = df['time'].diff().dt.total_seconds()
    df['distance'] = haversine_vec(df['lat'].shift(1), df['lon'].shift(1), df['lat'], df['lon'])

    total_time = df.loc[df['time_diff'] < engine_off_treshold, 'time_diff'].sum()
    total_distance = df['distance'].sum()

    print(f"Time behind the wheel (h): {total_time/3600:.2f}")
    print(f"Kilometers covered: {total_distance:.2f}")
    print(f"Avg speed: {total_distance/(total_time/3600):.2f}")

    geometry = [Point(xy) for xy in zip(df['lon'], df['lat'])]

    gdf = gpd.GeoDataFrame(df, geometry=geometry, crs="EPSG:4326")

    gdf.to_file("geojsons/driven.geojson", driver="GeoJSON")


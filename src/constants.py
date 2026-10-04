import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent if Path(__file__).resolve().parent.name == "src" else Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# Input and state files
DATA_DIR_PATH = Path("data")

STATE_FILE_PATH = DATA_DIR_PATH / "state.txt"
EPOCHS_FILE_PATH = DATA_DIR_PATH / "epochs.pkl"
DATA_FILE_PATH = DATA_DIR_PATH / "raw.txt"

ENGINE_OFF_THRESHOLD = 60

# Feature flags
PARSING_ENABLED = True
DRAWING_OSM_MAPS_ENABLED = True
DRAWING_DRIVEN_MAPS_ENABLED = True

# Map data
GEOJSON_DIR_PATH = Path("geojsons")
MAP_DIR_PATH = Path("maps")

OSM_PBF_FILENAME = os.getenv("OSM_FILE_NAME", "pomorskie.osm.pbf")

OSM_FILE_PATH = GEOJSON_DIR_PATH / OSM_PBF_FILENAME

OSM_FILE_NAME = Path(OSM_PBF_FILENAME).name.split(".")[0]

# General map settings
AVERAGE_ROAD_WIDTH = 6

WHITE = [255, 255, 255]
RED = [255, 0, 0]
PINK = [255, 105, 180]
YELLOW = [255, 255, 0]
ORANGE = [255, 165, 0]
PALE_ORANGE = [255, 200, 100]
FADED_BLUE = [135, 206, 235]
DARK_GRAY = [80, 80, 80]

MAP_LAYERS = {
    # "bodies_of_water": {
    #     "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_bodies_of_water.geojson",
    #     "color": FADED_BLUE,
    # },
    # "buildings": {
    #     "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_buildings.geojson",
    #     "color": DARK_GRAY,
    # },
    "dirt_roads": {
        "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_dirt_roads.geojson",
        "color": PALE_ORANGE,
        "width": AVERAGE_ROAD_WIDTH,
    },
    "all_roads": {
        "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_all_roads.geojson",
        "color": ORANGE,
        "width": AVERAGE_ROAD_WIDTH,
    },
    "speed_gt_50": {
        "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_speed_gt_50.geojson",
        "color": RED,
        "width": AVERAGE_ROAD_WIDTH * 2,
    },
    # "driven": {
    #     "path": GEOJSON_DIR_PATH / "driven.geojson",
    #     "color": WHITE,
    #     "width": AVERAGE_ROAD_WIDTH * 4,
    # },
    "traffic_calming": {
        "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_traffic_calming.geojson",
        "color": PINK,
        "width": AVERAGE_ROAD_WIDTH * 3,
    },
    "traffic_lights": {
        "path": GEOJSON_DIR_PATH / f"{OSM_FILE_NAME}_traffic_lights.geojson",
        "color": YELLOW,
        "width": AVERAGE_ROAD_WIDTH * 3,
    },
}
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent if Path(__file__).resolve().parent.name == "src" else Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# Katalog i pliki wejściowe / stan parsowania
DATA_DIR_PATH = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))

DATA_FILE_PATH = Path(os.getenv("DATA_FILE", DATA_DIR_PATH / "raw.txt"))
STATE_FILE_PATH = Path(os.getenv("STATE_FILE", DATA_DIR_PATH / "state.txt"))

PLOTS_DIR = Path(os.getenv("PLOTS_DIR", BASE_DIR / "plots"))
PLOTS_DIR.mkdir(parents=True, exist_ok=True)

# Połączenie z bazą danych
DB_URL = os.environ["DB_URL"]

CORS_ORIGINS = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]

DEFAULT_PROFILE_USERNAME = os.getenv("DEFAULT_PROFILE_USERNAME", "admin")
DEFAULT_PROFILE_NAME = os.getenv("DEFAULT_PROFILE_NAME", "samochód")
DEFAULT_PROFILE_EMAIL_DOMAIN = os.getenv("DEFAULT_PROFILE_EMAIL_DOMAIN", "local.dev")
DEFAULT_PROFILE_PASSWORD_HASH = os.getenv("DEFAULT_PROFILE_PASSWORD_HASH", "placeholder_hash")

MAX_HDOP = float(os.getenv("MAX_HDOP", "5.0"))
PREFERRED_HDOP = float(os.getenv("PREFERRED_HDOP", "3.0"))
MAX_SPEED_KMH = float(os.getenv("MAX_SPEED_KMH", "500.0"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "10000"))
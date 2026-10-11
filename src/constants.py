import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent if Path(__file__).resolve().parent.name == "src" else Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# Katalog i pliki wejściowe / stan parsowania
DATA_DIR_PATH = BASE_DIR / "data"

DATA_FILE_PATH = DATA_DIR_PATH / "raw.txt"
STATE_FILE_PATH = DATA_DIR_PATH / "state.txt"

# Połączenie z bazą danych
DB_URL = os.getenv("DB_URL", "postgresql://nnaper:nnaper@localhost:5432/nnaper_db")
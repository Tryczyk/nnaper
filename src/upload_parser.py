"""
Upload Parser - moduł wsadowego i wieloplikowego przetwarzania danych GPS dla NNAPER API.
Zoptymalizowany pod kątem ogromnych plików (nawet 650 MB - 10 GB) bez przepełniania pamięci RAM.
Czyta pliki strumieniowo z dysku linijka po linijce, raportuje postęp w bajtach i liniach,
oraz strumieniuje zdarzenia NDJSON do przeglądarki.
"""

from datetime import datetime, timezone
import math
import os
from pathlib import Path
import re
import time
import uuid

from constants import (
    BASE_DIR,
    DB_URL,
    MATCH_CHUNK_SIZE,
    MAX_SPEED_KMH,
    OSRM_URL,
)
from parser import (
    CopyBatchBuffer,
    RawEpoch,
    ddm_to_dd,
    get_part,
    parse_nmea_time,
    run_map_matching_on_epochs,
    split_line,
    to_float_or_none,
    to_int_or_none,
)


def _parse_iso_datetime(dt_str: str) -> datetime | None:
    if not dt_str:
        return None
    cleaned = dt_str.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(cleaned, fmt).replace(tzinfo=timezone.utc)
        except Exception:
            pass
    return None


def parse_gpx_disk_stream(
    file_path: Path,
    filename: str,
    profile_id: str,
    cur,
    conn,
    snap_to_roads: bool = True,
    batch_size: int = 3000,
    previous_point=None,
    abort_check=None,
):
    """Parsuje pliki GPX ze śledzeniem postępu bajtowego i kalkulacją ETA."""
    total_bytes = file_path.stat().st_size
    yield {
        "type": "progress",
        "stage": "parsing",
        "percent": 5,
        "lines": 0,
        "epochs": 0,
        "eta_str": "--:--",
        "speed_mb_s": 0.0,
        "message": f"Wczytywanie i parsowanie punktów GPX: {filename}...",
        "filename": filename,
    }

    buffer = CopyBatchBuffer(profile_id=profile_id, previous_point=previous_point)
    epochs_added = 0
    unique_days = set()

    trkpt_regex = re.compile(
        r'<trkpt\s+[^>]*lat=["\']([^"\']+)["\'][^>]*lon=["\']([^"\']+)["\'][^>]*>(.*?)</trkpt>',
        re.DOTALL | re.IGNORECASE,
    )
    time_regex = re.compile(r'<time>([^<]+)</time>', re.IGNORECASE)

    processed_bytes = 0
    chunk_size = 1024 * 1024 * 4  # 4 MB chunk
    remainder = ""
    t_start = time.time()
    last_yield_time = time.time()

    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        while True:
            if abort_check and abort_check():
                yield {
                    "type": "aborted",
                    "stage": "aborted",
                    "filename": filename,
                    "message": "Parsowanie pliku GPX przerwane przez użytkownika.",
                }
                return

            chunk = f.read(chunk_size)
            if not chunk:
                break
            processed_bytes += len(chunk.encode("utf-8", errors="ignore"))
            data = remainder + chunk

            # Znajdź ostatni zamknięty tag </trkpt>
            last_close = data.rfind("</trkpt>")
            if last_close != -1:
                to_process = data[: last_close + 8]
                remainder = data[last_close + 8 :]
            else:
                to_process = ""
                remainder = data

            for m in trkpt_regex.finditer(to_process):
                lat_str, lon_str, inner = m.group(1), m.group(2), m.group(3)
                try:
                    lat = float(lat_str)
                    lon = float(lon_str)
                except ValueError:
                    continue

                t_match = time_regex.search(inner)
                dt = _parse_iso_datetime(t_match.group(1)) if t_match else None
                if dt:
                    unique_days.add(dt.strftime("%Y-%m-%d"))

                epoch = RawEpoch()
                epoch.gprmc = (
                    dt.time() if dt else None,
                    "A",
                    lat,
                    lon,
                    dt.date() if dt else None,
                    None,
                )

                buffer.add_epoch(epoch, last_known_date=dt.date() if dt else None)
                epochs_added += 1

                if len(buffer.epochs) >= batch_size or (time.time() - last_yield_time > 0.85):
                    elapsed = max(0.001, time.time() - t_start)
                    bytes_per_sec = processed_bytes / elapsed
                    remaining_bytes = max(0, total_bytes - processed_bytes)
                    eta_sec = int(remaining_bytes / max(1.0, bytes_per_sec)) if bytes_per_sec > 0 else 0
                    eta_m = eta_sec // 60
                    eta_s = eta_sec % 60
                    eta_str = f"{eta_m:02d}:{eta_s:02d}"
                    speed_mb = bytes_per_sec / (1024 * 1024)
                    pct = min(95, max(1, int((processed_bytes / max(1, total_bytes)) * 100)))

                    if len(buffer.epochs) >= batch_size:
                        stage_name = "matching" if snap_to_roads else "saving"
                        yield {
                            "type": "progress",
                            "stage": stage_name,
                            "percent": pct,
                            "lines": epochs_added,
                            "epochs": epochs_added,
                            "processed_bytes": processed_bytes,
                            "total_bytes": total_bytes,
                            "eta_seconds": eta_sec,
                            "eta_str": eta_str,
                            "speed_mb_s": round(speed_mb, 1),
                            "message": (
                                f"Dociąganie do dróg OSRM ({epochs_added} punktów GPX, ETA: ~{eta_str})..."
                                if snap_to_roads
                                else f"Zapisywanie punktów ({epochs_added} punktów GPX, ETA: ~{eta_str})..."
                            ),
                            "filename": filename,
                        }

                        if not snap_to_roads:
                            for ep in buffer.epochs:
                                if ep.get("geom_snapped") is None:
                                    ep["geom_snapped"] = ep["geom"]

                        buffer.flush(cur)
                        conn.commit()
                        last_yield_time = time.time()

                    elif time.time() - last_yield_time > 0.85:
                        yield {
                            "type": "progress",
                            "stage": "parsing",
                            "percent": pct,
                            "lines": epochs_added,
                            "epochs": epochs_added,
                            "processed_bytes": processed_bytes,
                            "total_bytes": total_bytes,
                            "eta_seconds": eta_sec,
                            "eta_str": eta_str,
                            "speed_mb_s": round(speed_mb, 1),
                            "message": f"Parsowanie punktów GPX ({epochs_added:,} punktów, ETA: ~{eta_str})...",
                            "filename": filename,
                        }
                        last_yield_time = time.time()

    if buffer.epochs:
        yield {
            "type": "progress",
            "stage": "saving",
            "percent": 96,
            "lines": epochs_added,
            "epochs": epochs_added,
            "message": "Finalizowanie zapisu do bazy danych...",
            "filename": filename,
        }
        if not snap_to_roads:
            for ep in buffer.epochs:
                if ep.get("geom_snapped") is None:
                    ep["geom_snapped"] = ep["geom"]
        buffer.flush(cur)
        conn.commit()

    yield {
        "type": "done",
        "stage": "done",
        "filename": filename,
        "epochs": epochs_added,
        "satellites": 0,
        "days": sorted(list(unique_days)),
        "percent": 100,
        "message": f"Zakończono: zaimportowano {epochs_added} punktów GPX.",
    }


def parse_csv_disk_stream(
    file_path: Path,
    filename: str,
    profile_id: str,
    cur,
    conn,
    snap_to_roads: bool = True,
    batch_size: int = 3000,
    previous_point=None,
    abort_check=None,
):
    """Parsuje pliki CSV linijka po linijce ze śledzeniem postępu, obsługą przeciążeń G-sensor i kalkulacją ETA."""
    total_bytes = file_path.stat().st_size
    buffer = CopyBatchBuffer(profile_id=profile_id, previous_point=previous_point)
    epochs_added = 0
    unique_days = set()

    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        first_line = f.readline()
        if not first_line:
            yield {
                "type": "done",
                "stage": "done",
                "filename": filename,
                "epochs": 0,
                "satellites": 0,
                "days": [],
                "percent": 100,
                "message": "Pusty plik CSV.",
            }
            return

        delimiter = ";" if ";" in first_line else ","
        raw_headers = [h.strip().lower().strip('"\'') for h in first_line.split(delimiter)]

        lat_idx, lon_idx, time_idx = -1, -1, -1
        gx_idx, gy_idx, gz_idx = -1, -1, -1

        for i, raw_col in enumerate(raw_headers):
            # Normalizacja nazwy kolumny
            col = raw_col.replace("-", "_").replace(" ", "_").strip()
            col_clean = re.sub(r"[\(\[].*?[\)\]]", "", col).strip("_ ")

            if col_clean in ("lat", "latitude", "szerokosc", "szerokość", "lat_y", "y"):
                lat_idx = i
            elif col_clean in ("lon", "lng", "longitude", "dlugosc", "długość", "lon_x", "x"):
                lon_idx = i
            elif col_clean in ("time", "timestamp", "datetime", "czas", "data", "date_time"):
                time_idx = i
            elif col_clean in ("gx", "g_x", "accel_x", "acc_x", "ax", "przeciazenie_x", "przeciążenie_x", "gforce_x", "g_force_x"):
                gx_idx = i
            elif col_clean in ("gy", "g_y", "accel_y", "acc_y", "ay", "przeciazenie_y", "przeciążenie_y", "gforce_y", "g_force_y"):
                gy_idx = i
            elif col_clean in ("gz", "g_z", "accel_z", "acc_z", "az", "przeciazenie_z", "przeciążenie_z", "gforce_z", "g_force_z"):
                gz_idx = i

        if lat_idx == -1 or lon_idx == -1:
            yield {
                "type": "error",
                "stage": "error",
                "filename": filename,
                "error": "Brak kolumn lat i lon w pliku CSV",
                "message": "Nie znaleziono kolumn 'lat' i 'lon' w nagłówku CSV.",
            }
            return

        processed_bytes = len(first_line.encode("utf-8", errors="ignore"))
        t_start = time.time()
        last_yield_time = time.time()

        for idx, line in enumerate(f, start=1):
            if abort_check and abort_check():
                yield {
                    "type": "aborted",
                    "stage": "aborted",
                    "filename": filename,
                    "message": "Parsowanie pliku CSV przerwane przez użytkownika.",
                }
                return

            processed_bytes += len(line.encode("utf-8", errors="ignore"))
            parts = [p.strip().strip('"\'') for p in line.split(delimiter)]
            if len(parts) <= max(lat_idx, lon_idx):
                continue

            try:
                lat = float(parts[lat_idx].replace(",", "."))
                lon = float(parts[lon_idx].replace(",", "."))
            except ValueError:
                continue

            dt = None
            if time_idx != -1 and time_idx < len(parts):
                dt = _parse_iso_datetime(parts[time_idx])
                if dt:
                    unique_days.add(dt.strftime("%Y-%m-%d"))

            epoch = RawEpoch()
            epoch.gprmc = (
                dt.time() if dt else None,
                "A",
                lat,
                lon,
                dt.date() if dt else None,
                None,
            )

            # Obsługa przeciążeń G-force (X, Y, Z)
            if gx_idx != -1 or gy_idx != -1 or gz_idx != -1:
                gx_val = parts[gx_idx] if (0 <= gx_idx < len(parts)) else None
                gy_val = parts[gy_idx] if (0 <= gy_idx < len(parts)) else None
                gz_val = parts[gz_idx] if (0 <= gz_idx < len(parts)) else None
                if (gx_val and gx_val.strip()) or (gy_val and gy_val.strip()) or (gz_val and gz_val.strip()):
                    epoch.gsensord = (
                        gx_val.strip().replace(",", ".") if gx_val else None,
                        gy_val.strip().replace(",", ".") if gy_val else None,
                        gz_val.strip().replace(",", ".") if gz_val else None,
                    )

            buffer.add_epoch(epoch, last_known_date=dt.date() if dt else None)
            epochs_added += 1

            if len(buffer.epochs) >= batch_size or (time.time() - last_yield_time > 0.85):
                elapsed = max(0.001, time.time() - t_start)
                bytes_per_sec = processed_bytes / elapsed
                remaining_bytes = max(0, total_bytes - processed_bytes)
                eta_sec = int(remaining_bytes / max(1.0, bytes_per_sec)) if bytes_per_sec > 0 else 0
                eta_m = eta_sec // 60
                eta_s = eta_sec % 60
                eta_str = f"{eta_m:02d}:{eta_s:02d}"
                speed_mb = bytes_per_sec / (1024 * 1024)
                pct = min(95, max(1, int((processed_bytes / max(1, total_bytes)) * 100)))

                if len(buffer.epochs) >= batch_size:
                    stage_name = "matching" if snap_to_roads else "saving"
                    yield {
                        "type": "progress",
                        "stage": stage_name,
                        "percent": pct,
                        "lines": idx,
                        "epochs": epochs_added,
                        "processed_bytes": processed_bytes,
                        "total_bytes": total_bytes,
                        "eta_seconds": eta_sec,
                        "eta_str": eta_str,
                        "speed_mb_s": round(speed_mb, 1),
                        "message": (
                            f"Dociąganie do dróg OSRM ({epochs_added} wierszy CSV, ETA: ~{eta_str})..."
                            if snap_to_roads
                            else f"Zapisywanie wierszy CSV ({idx:,} wierszy, ETA: ~{eta_str})..."
                        ),
                        "filename": filename,
                    }
                    if not snap_to_roads:
                        for ep in buffer.epochs:
                            if ep.get("geom_snapped") is None:
                                ep["geom_snapped"] = ep["geom"]
                    buffer.flush(cur)
                    conn.commit()
                    last_yield_time = time.time()

                elif time.time() - last_yield_time > 0.85:
                    yield {
                        "type": "progress",
                        "stage": "parsing",
                        "percent": pct,
                        "lines": idx,
                        "epochs": epochs_added,
                        "processed_bytes": processed_bytes,
                        "total_bytes": total_bytes,
                        "eta_seconds": eta_sec,
                        "eta_str": eta_str,
                        "speed_mb_s": round(speed_mb, 1),
                        "message": f"Parsowanie tabeli CSV ({idx:,} wierszy, {epochs_added} epok, ETA: ~{eta_str})...",
                        "filename": filename,
                    }
                    last_yield_time = time.time()

    if buffer.epochs:
        yield {
            "type": "progress",
            "stage": "saving",
            "percent": 96,
            "lines": epochs_added,
            "epochs": epochs_added,
            "message": "Finalizowanie zapisu do bazy danych...",
            "filename": filename,
        }
        if not snap_to_roads:
            for ep in buffer.epochs:
                if ep.get("geom_snapped") is None:
                    ep["geom_snapped"] = ep["geom"]
        buffer.flush(cur)
        conn.commit()

    yield {
        "type": "done",
        "stage": "done",
        "filename": filename,
        "epochs": epochs_added,
        "satellites": 0,
        "days": sorted(list(unique_days)),
        "percent": 100,
        "message": f"Zakończono: zaimportowano {epochs_added} punktów z CSV.",
    }


def parse_nmea_disk_stream(
    file_path: Path,
    filename: str,
    profile_id: str,
    cur,
    conn,
    snap_to_roads: bool = True,
    batch_size: int = 4000,
    previous_point=None,
    abort_check=None,
):
    """
    Parsuje gigantyczne pliki NMEA / LOG linijka po linijce ze znikomym zużyciem RAM (~15 KB).
    Dokładnie oblicza procent na podstawie przeczytanych bajtów z dysku oraz estymację ETA.
    """
    total_bytes = file_path.stat().st_size
    yield {
        "type": "progress",
        "stage": "parsing",
        "percent": 5,
        "lines": 0,
        "epochs": 0,
        "eta_str": "--:--",
        "speed_mb_s": 0.0,
        "message": f"Rozpoczynanie parsowania pliku ({total_bytes / (1024*1024):.1f} MB)...",
        "filename": filename,
    }

    buffer = CopyBatchBuffer(profile_id=profile_id, previous_point=previous_point)
    epoch = RawEpoch()
    epochs_in_batch = 0
    total_epochs_saved = 0
    total_satellites_saved = 0
    unique_days = set()
    last_known_date = (
        previous_point[0].date()
        if (previous_point and previous_point[0] is not None)
        else None
    )

    processed_bytes = 0
    t_start = time.time()
    last_yield_time = time.time()

    with open(str(file_path), "r", encoding="utf-8", errors="replace") as data_file:
        for current_number, line in enumerate(data_file, start=1):
            if abort_check and abort_check():
                yield {
                    "type": "error",
                    "stage": "aborted",
                    "percent": 0,
                    "message": "Parsowanie przerwane na życzenie użytkownika.",
                    "filename": filename,
                }
                return
            line_bytes_len = len(line.encode("utf-8", errors="ignore"))
            processed_bytes += line_bytes_len

            raw_line = line.strip()
            if not raw_line:
                continue

            # Tolerancja na prefiksy czasowe (np. `2026-10-14 12:34:56 $GPRMC,...`)
            idx_g = raw_line.find("$G")
            if idx_g >= 0:
                raw_line = raw_line[idx_g:]
            elif not raw_line.startswith("$"):
                continue

            parts = split_line(raw_line)
            parts_count = len(parts)
            tag = parts[0].upper()

            if tag.endswith("SENSORD") or tag == "$GSENSORD":
                if epoch.gsensord:
                    buffer.add_epoch(epoch, last_known_date=last_known_date)
                    epochs_in_batch += 1
                    epoch = RawEpoch()
                epoch.gsensord = (
                    get_part(parts, 1),
                    get_part(parts, 2),
                    get_part(parts, 3),
                )

            elif tag.endswith("RMC") or tag in ("$GPRMC", "$GNRMC"):
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
                        dt = datetime.strptime(f"{d_val}{t_utc}", "%d%m%y%H%M%S.%f")
                        parsed_time = dt.time()
                        parsed_date = dt.date()
                    except ValueError:
                        pass
                if not parsed_time and t_utc:
                    parsed_time = parse_nmea_time(t_utc)

                if parsed_date:
                    last_known_date = parsed_date
                    unique_days.add(parsed_date.strftime("%Y-%m-%d"))

                epoch.gprmc = (
                    parsed_time,
                    get_part(parts, 2),
                    lat,
                    lon,
                    parsed_date,
                    None,
                )

            elif tag.endswith("GGA") or tag in ("$GPGGA", "$GNGGA"):
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

            elif tag.endswith("GSV") or tag in ("$GPGSV", "$GLGSV", "$GAGSV", "$GBGSV", "$BDGSV"):
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

            # Okresowy flushing partii oraz obliczenia ETA
            if epochs_in_batch >= batch_size or (time.time() - last_yield_time > 0.85):
                elapsed = max(0.001, time.time() - t_start)
                bytes_per_sec = processed_bytes / elapsed
                remaining_bytes = max(0, total_bytes - processed_bytes)
                eta_sec = int(remaining_bytes / max(1.0, bytes_per_sec)) if bytes_per_sec > 0 else 0
                eta_m = eta_sec // 60
                eta_s = eta_sec % 60
                eta_str = f"{eta_m:02d}:{eta_s:02d}"
                speed_mb = bytes_per_sec / (1024 * 1024)
                pct = min(95, max(1, int((processed_bytes / max(1, total_bytes)) * 100)))

                if epochs_in_batch >= batch_size:
                    count = len(buffer.epochs)
                    sats_count = len(buffer.satellite)
                    stage_name = "matching" if snap_to_roads else "saving"

                    yield {
                        "type": "progress",
                        "stage": stage_name,
                        "percent": pct,
                        "lines": current_number,
                        "epochs": total_epochs_saved + count,
                        "satellites": total_satellites_saved + sats_count,
                        "processed_bytes": processed_bytes,
                        "total_bytes": total_bytes,
                        "eta_seconds": eta_sec,
                        "eta_str": eta_str,
                        "speed_mb_s": round(speed_mb, 1),
                        "message": (
                            f"Dociąganie do dróg OSRM ({count} epok, ETA: ~{eta_str}, {speed_mb:.1f} MB/s)..."
                            if snap_to_roads
                            else f"Zapisywanie {count} epok (ETA: ~{eta_str}, {speed_mb:.1f} MB/s)..."
                        ),
                        "filename": filename,
                    }

                    if not snap_to_roads:
                        for ep in buffer.epochs:
                            if ep.get("geom_snapped") is None:
                                ep["geom_snapped"] = ep["geom"]

                    buffer.flush(cur)
                    conn.commit()

                    total_epochs_saved += count
                    total_satellites_saved += sats_count
                    epochs_in_batch = 0
                    last_yield_time = time.time()

                elif time.time() - last_yield_time > 0.85:
                    yield {
                        "type": "progress",
                        "stage": "parsing",
                        "percent": pct,
                        "lines": current_number,
                        "epochs": total_epochs_saved + len(buffer.epochs),
                        "satellites": total_satellites_saved + len(buffer.satellite),
                        "processed_bytes": processed_bytes,
                        "total_bytes": total_bytes,
                        "eta_seconds": eta_sec,
                        "eta_str": eta_str,
                        "speed_mb_s": round(speed_mb, 1),
                        "message": f"Parsowanie linii {current_number:,} ({pct}%, ETA: ~{eta_str}, {speed_mb:.1f} MB/s)...",
                        "filename": filename,
                    }
                    last_yield_time = time.time()

    # Ostatnia partia
    if epoch.gprmc or epoch.gpgga or epoch.gpgsvs or epoch.gsensord:
        buffer.add_epoch(epoch, last_known_date=last_known_date)

    if buffer.epochs:
        count = len(buffer.epochs)
        sats_count = len(buffer.satellite)
        yield {
            "type": "progress",
            "stage": "saving",
            "percent": 96,
            "lines": current_number,
            "epochs": total_epochs_saved + count,
            "satellites": total_satellites_saved + sats_count,
            "message": f"Zapisywanie końcowej partii {count} epok do bazy PostgreSQL...",
            "filename": filename,
        }

        if not snap_to_roads:
            for ep in buffer.epochs:
                if ep.get("geom_snapped") is None:
                    ep["geom_snapped"] = ep["geom"]

        buffer.flush(cur)
        conn.commit()

        total_epochs_saved += count
        total_satellites_saved += sats_count

    yield {
        "type": "done",
        "stage": "done",
        "filename": filename,
        "epochs": total_epochs_saved,
        "satellites": total_satellites_saved,
        "days": sorted(list(unique_days)),
        "percent": 100,
        "message": f"Zakończono: zaimportowano {total_epochs_saved:,} punktów GPS, {total_satellites_saved:,} satelitów.",
    }


def find_go_parser_binary() -> Path | None:
    import sys
    is_windows = sys.platform.startswith("win") or os.name == "nt"
    if is_windows:
        candidates = [
            BASE_DIR / "go-parser" / "nnaper-parser.exe",
            BASE_DIR / "nnaper-parser.exe",
        ]
    else:
        candidates = [
            BASE_DIR / "go-parser" / "nnaper-parser",
            BASE_DIR / "nnaper-parser",
        ]
    for c in candidates:
        if c.is_file():
            if not is_windows:
                try:
                    os.chmod(str(c), 0o755)
                except Exception:
                    pass
            return c
    return None


def parse_with_go_binary(
    bin_path: Path,
    file_path: Path,
    filename: str,
    profile_id: str,
    snap_to_roads: bool = True,
    abort_check=None,
):
    import json
    import subprocess

    cmd = [
        str(bin_path),
        "-file", str(file_path),
        "-profile-id", str(profile_id),
        "-db-url", str(DB_URL),
        "-osrm-url", str(OSRM_URL),
        f"-snap={'true' if snap_to_roads else 'false'}",
        "-json-progress=true",
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    try:
        if proc.stdout:
            for line in proc.stdout:
                if abort_check and abort_check():
                    proc.terminate()
                    yield {
                        "type": "aborted",
                        "stage": "aborted",
                        "filename": filename,
                        "message": "Parsowanie przerwane na życzenie użytkownika.",
                    }
                    return

                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    event = json.loads(line_str)
                    yield event
                except Exception:
                    pass

        proc.wait()
        if proc.returncode != 0:
            err_msg = proc.stderr.read() if proc.stderr else "Błąd procesu Go"
            yield {
                "type": "error",
                "stage": "error",
                "filename": filename,
                "message": f"Go Parser: {err_msg}",
            }
    except Exception as exc:
        yield {
            "type": "error",
            "stage": "error",
            "filename": filename,
            "message": f"Błąd wykonania Go: {str(exc)}",
        }


def parse_file_disk_stream(
    file_path: Path,
    filename: str,
    profile_id: str,
    cur,
    conn,
    snap_to_roads: bool = True,
    batch_size: int = 4000,
    abort_check=None,
):
    """
    Główny punkt wejścia dla przetwarzania pliku z dysku.
    Automatycznie wybiera ultra-szybki silnik w Go (jeśli skompilowany)
    lub zoptymalizowany strumieniowy parser w Pythonie.
    """
    go_bin = find_go_parser_binary()
    if go_bin is not None:
        yield from parse_with_go_binary(
            go_bin,
            file_path,
            filename,
            profile_id,
            snap_to_roads=snap_to_roads,
            abort_check=abort_check,
        )
        return

    try:
        cur.execute("SET synchronous_commit = OFF;")
        cur.execute("SET work_mem = '64MB';")
    except Exception:
        pass

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
    if last_row and last_row[1] is not None and last_row[2] is not None:
        previous_point = (
            last_row[0],
            float(last_row[1]),
            float(last_row[2]),
        )

    lower_name = filename.lower()

    # Odczyt próbki nagłówka (pierwsze 4 KB)
    with open(str(file_path), "rb") as f:
        sample_bytes = f.read(4096)

    try:
        sample_text = sample_bytes.decode("utf-8")
    except UnicodeDecodeError:
        sample_text = sample_bytes.decode("latin-1", errors="replace")

    sample_lower = sample_text.lower()

    if lower_name.endswith(".gpx") or "<gpx" in sample_lower:
        yield from parse_gpx_disk_stream(
            file_path,
            filename,
            profile_id,
            cur,
            conn,
            snap_to_roads=snap_to_roads,
            batch_size=batch_size,
            previous_point=previous_point,
            abort_check=abort_check,
        )
    elif lower_name.endswith(".csv") or (
        ("," in sample_lower or ";" in sample_lower)
        and any(k in sample_lower for k in ("lat", "szeroko", "longitude", "dlugosc", "długo"))
    ):
        yield from parse_csv_disk_stream(
            file_path,
            filename,
            profile_id,
            cur,
            conn,
            snap_to_roads=snap_to_roads,
            batch_size=batch_size,
            previous_point=previous_point,
            abort_check=abort_check,
        )
    else:
        yield from parse_nmea_disk_stream(
            file_path,
            filename,
            profile_id,
            cur,
            conn,
            snap_to_roads=snap_to_roads,
            batch_size=batch_size,
            previous_point=previous_point,
            abort_check=abort_check,
        )

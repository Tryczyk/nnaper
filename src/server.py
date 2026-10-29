from contextlib import asynccontextmanager
from datetime import datetime
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from constants import DB_URL, CORS_ORIGINS

pool: ConnectionPool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    pool = ConnectionPool(
        conninfo=DB_URL,
        min_size=2,
        max_size=20,
        open=True,
    )
    yield
    if pool is not None:
        pool.close()


def get_db():
    if pool is not None:
        return pool.connection()
    return psycopg.connect(DB_URL)


app = FastAPI(title="nnaper API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/dates-tree")
def get_dates_tree():
    query = """
        SELECT DISTINCT 
            EXTRACT(YEAR FROM timestamp)::int AS y,
            EXTRACT(MONTH FROM timestamp)::int AS m,
            EXTRACT(DAY FROM timestamp)::int AS d
        FROM epochs
        ORDER BY y DESC, m DESC, d DESC;
    """
    tree = {}
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            for y, m, d in cur.fetchall():
                y_str = str(y)
                m_str = str(m).zfill(2)
                d_str = str(d).zfill(2)
                tree.setdefault(y_str, {}).setdefault(m_str, []).append(d_str)
    return tree


@app.get("/api/track/{z}/{x}/{y}.pbf")
def get_track_tile(z: int, x: int, y: int, days: str = Query(None)):
    """Zwraca dynamiczny kafelek Mapbox Vector Tile dla śladu GPS."""
    if z < 0 or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        raise HTTPException(status_code=400, detail="Nieprawidłowe współrzędne kafelka")

    day_list = None
    if days and days != "none":
        day_list = [day.strip() for day in days.split(",") if day.strip()]
        if not day_list:
            day_list = None

    where_clauses = [
        "e.geom && ST_Transform(ST_TileEnvelope(%s, %s, %s), 4326)",
    ]
    params = [z, x, y]
    if days == "none":
        where_clauses.append("FALSE")
    elif day_list:
        where_clauses.append("e.timestamp::date = ANY(%s::date[])")
        where_clauses.extend([
            "e.timestamp >= %s::date",
            "e.timestamp < (%s::date + INTERVAL '1 day')",
        ])
        params.extend([day_list, min(day_list), max(day_list)])

    query = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        tile_features AS (
            SELECT
                e.epoch_id::text AS epoch_id,
                e.timestamp::date::text AS day,
                to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
                round(ST_Y(e.geom)::numeric, 6) AS latitude,
                round(ST_X(e.geom)::numeric, 6) AS longitude,
                ST_AsMVTGeom(
                    ST_Transform(e.geom, 3857),
                    bounds.geom,
                    4096,
                    64,
                    TRUE
                ) AS geom
            FROM epochs e
            CROSS JOIN bounds
            WHERE {' AND '.join(where_clauses)}
        )
        SELECT ST_AsMVT(tile_features, 'gps-track', 4096, 'geom')
        FROM tile_features
        WHERE geom IS NOT NULL;
    """
    # ST_TileEnvelope is used once for the CTE and once for the index-friendly
    # bounding-box predicate, so both sets of placeholders are intentional.
    params = [z, x, y] + params
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL max_parallel_workers_per_gather = 0")
            cur.execute(query, params)
            tile = cur.fetchone()[0] or b""

    return Response(
        content=bytes(tile),
        media_type="application/vnd.mapbox-vector-tile",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/epoch/{epoch_id}")
def get_epoch_details(epoch_id: str):
    query = """
    SELECT json_build_object(
        'epoch_id', e.epoch_id,
        'profile_id', e.profile_id,
        'timestamp', e.timestamp,
        'latitude', round(ST_Y(e.geom)::numeric, 6),
        'longitude', round(ST_X(e.geom)::numeric, 6),
        'altitude', e.altitude,
        'speed_kmh', e.speed_kmh,
        'g_x', e.g_x,
        'g_y', e.g_y,
        'g_z', e.g_z,
        'satellites', COALESCE(
            (SELECT json_agg(json_build_object(
                'prn', sat.prn,
                'elevation', sat.elevation,
                'azimuth', sat.azimuth
            ) ORDER BY sat.prn)
             FROM satellite sat
             WHERE sat.epoch_id = e.epoch_id),
            '[]'::json
        )
    ) AS epoch
    FROM epochs e
    WHERE e.epoch_id = %(eid)s;
    """
    with get_db() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, {"eid": epoch_id})
            row = cur.fetchone()
            if not row or not row["epoch"]:
                return {"error": "Epoch not found"}
            return row["epoch"]


@app.get("/api/playback-day")
def get_playback_day(day: str = Query(...)):
    """Pobiera uporządkowaną listę epok telemetrycznych dla wybranego dnia z satelitami (zoptymalizowana wersja JSON)."""
    day_str = day.strip()
    try:
        datetime.strptime(day_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD.")

    query = """
    WITH day_epochs AS (
        SELECT 
            e.epoch_id,
            to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
            round(ST_Y(e.geom)::numeric, 6) AS lat,
            round(ST_X(e.geom)::numeric, 6) AS lon,
            e.altitude,
            e.speed_kmh,
            e.g_x,
            e.g_y,
            e.g_z
        FROM epochs e
        WHERE e.timestamp >= %s::date
          AND e.timestamp < (%s::date + INTERVAL '1 day')
        ORDER BY e.timestamp ASC
    ),
    day_satellites AS (
        SELECT 
            s.epoch_id,
            json_agg(json_build_object(
                'prn', s.prn,
                'elevation', s.elevation,
                'azimuth', s.azimuth
            ) ORDER BY s.prn) AS sats
        FROM satellite s
        JOIN day_epochs de ON s.epoch_id = de.epoch_id
        GROUP BY s.epoch_id
    )
    SELECT COALESCE(json_agg(
        json_build_object(
            'epoch_id', de.epoch_id,
            'timestamp', de.timestamp,
            'lat', de.lat,
            'lon', de.lon,
            'altitude', de.altitude,
            'speed_kmh', de.speed_kmh,
            'g_x', de.g_x,
            'g_y', de.g_y,
            'g_z', de.g_z,
            'satellites', COALESCE(ds.sats, '[]'::json)
        ) ORDER BY de.timestamp ASC
    )::text, '[]')
    FROM day_epochs de
    LEFT JOIN day_satellites ds ON de.epoch_id = ds.epoch_id;
    """
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(query, (day_str, day_str))
                row = cur.fetchone()
                raw_json = row[0] if (row and row[0]) else "[]"
                return Response(
                    content=raw_json,
                    media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"},
                )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd bazy danych: {str(e)}")

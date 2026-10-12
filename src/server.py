from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
import os

app = FastAPI(title="nnaper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_URL = os.getenv("DB_URL", "postgresql://nnaper:nnaper@localhost:5432/nnaper_db")

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
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            for y, m, d in cur.fetchall():
                y_str = str(y)
                m_str = str(m).zfill(2)
                d_str = str(d).zfill(2)
                tree.setdefault(y_str, {}).setdefault(m_str, []).append(d_str)
    return tree

@app.get("/api/track")
def get_track(days: str = Query(None)):
    where_clauses = []
    params = []
    if days:
        if days == "none":
            where_clauses.append("1 = 0")
        else:
            day_list = [d.strip() for d in days.split(",") if d.strip()]
            where_clauses.append("timestamp::date = ANY(%s::date[])")
            params.append(day_list)

    query = f"""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(
                json_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(geom)::json,
                    'properties', json_build_object(
                        'epoch_id', epoch_id,
                        'day', timestamp::date,
                        'timestamp', timestamp,
                        'latitude', round(ST_Y(geom)::numeric, 6),
                        'longitude', round(ST_X(geom)::numeric, 6),
                        'altitude', altitude,
                        'speed_kmh', speed_kmh
                    )
                )
            ), '[]'::json)
        ) AS geojson
        FROM epochs
        {"WHERE " + " AND ".join(where_clauses) if where_clauses else ""};
    """
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, params)
            row = cur.fetchone()
            return row["geojson"]


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
    with psycopg.connect(DB_URL) as conn:
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
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, {"eid": epoch_id})
            row = cur.fetchone()
            if not row or not row["epoch"]:
                return {"error": "Epoch not found"}
            return row["epoch"]


@app.get("/api/playback-day")
def get_playback_day(day: str = Query(...)):
    """Pobiera uporządkowaną listę epok telemetrycznych dla wybranego dnia z satelitami."""
    query = """
    SELECT 
        e.epoch_id,
        to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
        round(ST_Y(e.geom)::numeric, 6) AS lat,
        round(ST_X(e.geom)::numeric, 6) AS lon,
        e.altitude,
        e.speed_kmh,
        COALESCE((SELECT json_agg(to_jsonb(sat)) FROM satellite sat WHERE sat.epoch_id = e.epoch_id), '[]'::json) AS satellites
    FROM epochs e
    WHERE e.timestamp >= %s::date
      AND e.timestamp < (%s::date + INTERVAL '1 day')
    ORDER BY e.timestamp ASC;
    """
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, (day, day))
            return cur.fetchall()
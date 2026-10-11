from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
import os
import logging

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
        WHERE is_active = TRUE AND timestamp IS NOT NULL
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
    where_clauses = ["is_active = TRUE", "geom IS NOT NULL"]
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
                        'latitude', latitude,
                        'longitude', longitude,
                        'terminator', terminator
                    )
                )
            ), '[]'::json)
        ) AS geojson
        FROM epochs
        WHERE {' AND '.join(where_clauses)};
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
        "e.is_active = TRUE",
        "e.geom IS NOT NULL",
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
                e.latitude::float AS latitude,
                e.longitude::float AS longitude,
                e.terminator,
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
        'epoch', (SELECT to_jsonb(e) FROM epochs e WHERE e.epoch_id = %(eid)s),
        'profile', (SELECT to_jsonb(p) FROM epochs e JOIN profiles p ON p.profile_id = e.profile_id WHERE e.epoch_id = %(eid)s),
        'user', (SELECT json_build_object('user_id', u.user_id, 'username', u.username, 'email', u.email, 'created_at', u.created_at)
                 FROM epochs e JOIN profiles p ON p.profile_id = e.profile_id JOIN users u ON u.user_id = p.user_id WHERE e.epoch_id = %(eid)s),
        'sentences', COALESCE((
            SELECT json_agg(
                json_build_object(
                    'sentence_id', s.sentence_id,
                    'raw', s.raw,
                    'checksum', s.checksum,
                    'parts_count', s.parts_count,
                    'gsensord', (SELECT to_jsonb(g) FROM gsensord g WHERE g.sentence_id = s.sentence_id),
                    'gprmc', (SELECT to_jsonb(r) FROM gprmc r WHERE r.sentence_id = s.sentence_id),
                    'gpvtg', (SELECT to_jsonb(v) FROM gpvtg v WHERE v.sentence_id = s.sentence_id),
                    'gpgga', (SELECT to_jsonb(gga) FROM gpgga gga WHERE gga.sentence_id = s.sentence_id),
                    'gpgsa', (SELECT to_jsonb(gsa) FROM gpgsa gsa WHERE gsa.sentence_id = s.sentence_id),
                    'gpgsv', (
                        SELECT json_build_object(
                            'meta', to_jsonb(gsv),
                            'satellites', COALESCE((SELECT json_agg(to_jsonb(sat)) FROM satellite sat WHERE sat.sentence_id = s.sentence_id), '[]'::json)
                        )
                        FROM gpgsv gsv WHERE gsv.sentence_id = s.sentence_id
                    )
                )
            )
            FROM sentence s WHERE s.epoch_id = %(eid)s
        ), '[]'::json)
    ) AS full_data;
    """
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, {"eid": epoch_id})
            row = cur.fetchone()
            if not row or not row["full_data"] or not row["full_data"]["epoch"]:
                return {"error": "Epoch not found"}
            return row["full_data"]


@app.get("/api/playback-day")
def get_playback_day(day: str = Query(...)):
    """Pobiera uporządkowaną listę epok telemetrycznych dla wybranego dnia z satelitami."""
    query = """
    SELECT 
        e.epoch_id,
        to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
        e.latitude::float AS lat,
        e.longitude::float AS lon,
        COALESCE(
            (
                SELECT (v.speed_kmh)::float
                FROM sentence s
                JOIN gpvtg v ON v.sentence_id = s.sentence_id
                WHERE s.epoch_id = e.epoch_id
                LIMIT 1
            ),
            (
                SELECT (r.speed_knots * 1.852)::float
                FROM sentence s
                JOIN gprmc r ON r.sentence_id = s.sentence_id
                WHERE s.epoch_id = e.epoch_id
                LIMIT 1
            ),
            0.0
        ) AS speed_kmh,
        COALESCE(
            (
                SELECT (v.course_true)::float
                FROM sentence s
                JOIN gpvtg v ON v.sentence_id = s.sentence_id
                WHERE s.epoch_id = e.epoch_id
                LIMIT 1
            ),
            (
                SELECT (r.course)::float
                FROM sentence s
                JOIN gprmc r ON r.sentence_id = s.sentence_id
                WHERE s.epoch_id = e.epoch_id
                LIMIT 1
            ),
            0.0
        ) AS course,
        COALESCE(
            (
                SELECT json_agg(json_build_object(
                    'prn', sat.prn,
                    'elevation', sat.elevation,
                    'azimuth', sat.azimuth,
                    'snr', sat.snr
                ))
                FROM sentence s
                JOIN satellite sat ON sat.sentence_id = s.sentence_id
                WHERE s.epoch_id = e.epoch_id
            ),
            '[]'::json
        ) AS satellites
    FROM epochs e
    WHERE e.is_active = TRUE 
      AND e.geom IS NOT NULL 
      AND e.timestamp >= %s::date
      AND e.timestamp < (%s::date + INTERVAL '1 day')
    ORDER BY e.timestamp ASC;
    """
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, (day, day))
            return cur.fetchall()
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
import os

app = FastAPI(title="nnaper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
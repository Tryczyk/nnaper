from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime
import json
import threading
from typing import Optional
from fastapi import FastAPI, Query, HTTPException, Header
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
import hashlib
import secrets
from pydantic import BaseModel

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


@app.on_event("startup")
def ensure_db_indices():
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        username      VARCHAR(64) NOT NULL UNIQUE,
                        email         VARCHAR(255) UNIQUE,
                        password_hash VARCHAR(255) NOT NULL,
                        avatar_url    TEXT,
                        created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                cur.execute("ALTER TABLE users ALTER COLUMN email DROP NOT NULL;")
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS profiles (
                        profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                        name       VARCHAR(64) NOT NULL,
                        avatar_url TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        CONSTRAINT uq_user_profile_name UNIQUE (user_id, name)
                    );
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS user_sessions (
                        token       VARCHAR(128) PRIMARY KEY,
                        user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                        created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                    );
                """)
                cur.execute("CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);")
                cur.execute("ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_snapped GEOMETRY(Point, 4326);")
                cur.execute("ALTER TABLE epochs DROP COLUMN IF EXISTS geom_offroad CASCADE;")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs (timestamp ASC);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);")
                cur.execute("DROP INDEX IF EXISTS idx_epochs_geom_offroad;")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));")
                conn.commit()
    except Exception as e:
        print(f"[STARTUP DB WARNING] {e}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class AvatarRequest(BaseModel):
    avatar_url: Optional[str] = None


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
    return f"{salt}${key.hex()}"


def verify_password(password: str, hashed: str) -> bool:
    try:
        if "$" not in hashed:
            return False
        salt, key_hex = hashed.split("$", 1)
        key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
        return secrets.compare_digest(key.hex(), key_hex)
    except Exception:
        return False


_db_indices_ensured = False

def ensure_tables():
    global _db_indices_ensured
    if not _db_indices_ensured:
        ensure_db_indices()
        _db_indices_ensured = True


def get_user_from_token(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    ensure_tables()
    try:
        with get_db() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute("""
                    SELECT u.user_id, u.username, u.email, u.avatar_url, s.token
                    FROM user_sessions s
                    JOIN users u ON s.user_id = u.user_id
                    WHERE s.token = %s
                """, (token,))
                row = cur.fetchone()
                if row:
                    row["user_id"] = str(row["user_id"])
                    return row
    except Exception as err:
        print(f"[AUTH GET_USER ERROR] {err}")
    return None


def get_auth_user_id(token: Optional[str] = None, authorization: Optional[str] = None) -> Optional[str]:
    auth_token = token
    if not auth_token and authorization:
        parts = authorization.split(" ")
        if len(parts) == 2 and parts[0].lower() == "bearer":
            auth_token = parts[1]
    user = get_user_from_token(auth_token)
    if user and user.get("user_id"):
        return str(user["user_id"])
    return None


@app.post("/api/auth/register")
def register_user(req: RegisterRequest):
    ensure_tables()
    username = req.username.strip()
    password = req.password.strip()
    if len(username) < 3 or len(username) > 64:
        raise HTTPException(status_code=400, detail="Nazwa użytkownika musi mieć od 3 do 64 znaków.")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="Hasło musi mieć co najmniej 4 znaki.")

    email = req.email.strip() if req.email else None
    pw_hash = hash_password(password)

    with get_db() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT user_id, password_hash FROM users WHERE LOWER(username) = LOWER(%s)", (username,))
            existing = cur.fetchone()
            if existing:
                if existing.get("password_hash") == "placeholder_hash":
                    cur.execute("""
                        UPDATE users SET password_hash = %s WHERE user_id = %s
                        RETURNING user_id, username, email, avatar_url
                    """, (pw_hash, existing["user_id"]))
                    user = cur.fetchone()
                    user_id = user["user_id"]
                else:
                    raise HTTPException(status_code=400, detail="Użytkownik o takiej nazwie już istnieje.")
            else:
                if email:
                    cur.execute("SELECT user_id FROM users WHERE LOWER(email) = LOWER(%s)", (email,))
                    if cur.fetchone():
                        raise HTTPException(status_code=400, detail="Konto z takim adresem email już istnieje.")

                cur.execute("""
                    INSERT INTO users (username, email, password_hash, avatar_url)
                    VALUES (%s, %s, %s, NULL)
                    RETURNING user_id, username, email, avatar_url
                """, (username, email, pw_hash))
                user = cur.fetchone()
                user_id = user["user_id"]

                cur.execute("""
                    INSERT INTO profiles (user_id, name, avatar_url)
                    VALUES (%s, %s, NULL)
                    ON CONFLICT (user_id, name) DO NOTHING
                """, (user_id, username))

            token = secrets.token_urlsafe(32)
            cur.execute("""
                INSERT INTO user_sessions (token, user_id)
                VALUES (%s, %s)
            """, (token, user_id))
            conn.commit()

            return {
                "status": "ok",
                "token": token,
                "user": {
                    "user_id": str(user_id),
                    "username": user["username"],
                    "email": user["email"],
                    "avatar_url": user["avatar_url"]
                }
            }


@app.post("/api/auth/login")
def login_user(req: LoginRequest):
    ensure_tables()
    identifier = req.username.strip()
    password = req.password.strip()

    with get_db() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""
                SELECT user_id, username, email, password_hash, avatar_url
                FROM users
                WHERE LOWER(username) = LOWER(%s) OR (email IS NOT NULL AND LOWER(email) = LOWER(%s))
            """, (identifier, identifier))
            user = cur.fetchone()

            if user and user.get("password_hash") == "placeholder_hash":
                # Użytkownik seedowy parsera - ustaw hasło przy pierwszym logowaniu
                pw_hash = hash_password(password)
                cur.execute("UPDATE users SET password_hash = %s WHERE user_id = %s", (pw_hash, user["user_id"]))
            elif not user or not verify_password(password, user["password_hash"]):
                raise HTTPException(status_code=401, detail="Nieprawidłowa nazwa użytkownika lub hasło.")

            user_id = user["user_id"]
            token = secrets.token_urlsafe(32)
            cur.execute("""
                INSERT INTO user_sessions (token, user_id)
                VALUES (%s, %s)
            """, (token, user_id))
            conn.commit()

            return {
                "status": "ok",
                "token": token,
                "user": {
                    "user_id": str(user_id),
                    "username": user["username"],
                    "email": user["email"],
                    "avatar_url": user["avatar_url"]
                }
            }


@app.get("/api/auth/me")
def get_current_user(token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    auth_token = token
    if not auth_token and authorization:
        parts = authorization.split(" ")
        if len(parts) == 2 and parts[0].lower() == "bearer":
            auth_token = parts[1]

    user = get_user_from_token(auth_token)
    if not user:
        return {"authenticated": False, "user": None}

    return {
        "authenticated": True,
        "user": {
            "user_id": user["user_id"],
            "username": user["username"],
            "email": user["email"],
            "avatar_url": user["avatar_url"]
        }
    }


@app.post("/api/auth/avatar")
def update_user_avatar(req: AvatarRequest, token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    auth_token = token
    if not auth_token and authorization:
        parts = authorization.split(" ")
        if len(parts) == 2 and parts[0].lower() == "bearer":
            auth_token = parts[1]

    user = get_user_from_token(auth_token)
    if not user:
        raise HTTPException(status_code=401, detail="Brak autoryzacji.")

    avatar_data = req.avatar_url.strip() if req.avatar_url else None
    user_id = user["user_id"]

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users
                SET avatar_url = %s, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = %s::uuid
            """, (avatar_data, user_id))
            cur.execute("""
                UPDATE profiles
                SET avatar_url = %s
                WHERE user_id = %s::uuid
            """, (avatar_data, user_id))
            conn.commit()

    return {"status": "ok", "avatar_url": avatar_data}


@app.post("/api/auth/logout")
def logout_user(token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    auth_token = token
    if not auth_token and authorization:
        parts = authorization.split(" ")
        if len(parts) == 2 and parts[0].lower() == "bearer":
            auth_token = parts[1]

    if auth_token:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM user_sessions WHERE token = %s", (auth_token,))
                conn.commit()

    return {"status": "ok"}


@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    import traceback
    traceback.print_exc()
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"}
    )


@app.get("/api/dates-tree")
def get_dates_tree(token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return {}

    query = """
        SELECT DISTINCT 
            EXTRACT(YEAR FROM e.timestamp)::int AS y,
            EXTRACT(MONTH FROM e.timestamp)::int AS m,
            EXTRACT(DAY FROM e.timestamp)::int AS d
        FROM epochs e
        WHERE e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)
        ORDER BY y DESC NULLS LAST, m DESC NULLS LAST, d DESC NULLS LAST;
    """
    tree = {}
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, (user_id,))
            for y, m, d in cur.fetchall():
                if y is None or m is None or d is None:
                    y_str = "None"
                    m_str = "None"
                    d_str = "None"
                else:
                    y_str = str(y)
                    m_str = str(m).zfill(2)
                    d_str = str(d).zfill(2)
                tree.setdefault(y_str, {}).setdefault(m_str, [])
                if d_str not in tree[y_str][m_str]:
                    tree[y_str][m_str].append(d_str)
    return tree


@app.get("/api/time-tree")
def get_time_tree(day: str = Query(...), token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    """Pobiera dynamicznie strukturę godzin, minut i sekund dla wybranego dnia (lub None)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return {}

    day_str = day.strip()
    if day_str in ("None", "null"):
        where_time = "e.timestamp IS NULL"
        params = (user_id,)
    else:
        try:
            datetime.strptime(day_str, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None.")
        where_time = "e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')"
        params = (user_id, day_str, day_str)

    query = f"""
        SELECT DISTINCT 
            to_char(e.timestamp, 'HH24') AS h,
            to_char(e.timestamp, 'MI') AS mi,
            to_char(e.timestamp, 'SS') AS s
        FROM epochs e
        WHERE e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)
          AND {where_time}
        ORDER BY h DESC NULLS LAST, mi DESC NULLS LAST, s DESC NULLS LAST;
    """
    tree = {}
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            for h, mi, s in cur.fetchall():
                h_str = h if h is not None else "None"
                mi_str = mi if mi is not None else "None"
                s_str = s if s is not None else "None"
                tree.setdefault(h_str, {}).setdefault(mi_str, []).append(s_str)
    return tree


tile_cache = OrderedDict()
tile_cache_lock = threading.Lock()
MAX_CACHE_TILES = 8192

def get_from_tile_cache(key):
    with tile_cache_lock:
        if key in tile_cache:
            tile_cache.move_to_end(key)
            return tile_cache[key]
    return None

def put_in_tile_cache(key, value):
    with tile_cache_lock:
        tile_cache[key] = value
        tile_cache.move_to_end(key)
        if len(tile_cache) > MAX_CACHE_TILES:
            tile_cache.popitem(last=False)


@app.get("/api/cache/clear")
@app.post("/api/cache/clear")
def clear_tile_cache():
    with tile_cache_lock:
        tile_cache.clear()
    return {"status": "ok", "message": "Pamięć podręczna kafelków została wyczyszczona"}


@app.get("/api/track/{z}/{x}/{y}.pbf")
def get_track_tile(
    z: int,
    x: int,
    y: int,
    days: str = Query(None),
    snapped: bool = Query(False),
    mode: str = Query("raw"),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Zwraca dynamiczny kafelek Mapbox Vector Tile dla śladu GPS w wybranym trybie:
    - raw: surowe pozycje GPS (punkty e.geom)
    - snapped: zsnapowane pozycje GPS (punkty e.geom_snapped)
    - osm: pozycje na drogach OSM wykorzystywane do podświetlenia dróg w tle
    """
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return Response(
            content=b"",
            media_type="application/vnd.mapbox-vector-tile",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )

    if z < 0 or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        raise HTTPException(status_code=400, detail="Nieprawidłowe współrzędne kafelka")

    if snapped and mode == "raw":
        mode = "snapped"

    cache_key = (user_id, z, x, y, days, snapped, mode)
    cached_tile = get_from_tile_cache(cache_key)
    if cached_tile is not None:
        return Response(
            content=cached_tile,
            media_type="application/vnd.mapbox-vector-tile",
            headers={
                "Cache-Control": "private, max-age=1800, stale-while-revalidate=3600",
                "Access-Control-Allow-Origin": "*",
            },
        )

    day_list = None
    if days and days not in ("__none__", "none", "empty", "false"):
        day_list = [day.strip() for day in days.split(",") if day.strip()]
        if not day_list:
            day_list = None

    where_params = [z, x, y]

    if mode == "osm":
        active_geom = "e.geom_line"
        where_clauses = [
            "e.geom_line IS NOT NULL",
            "e.geom_line && ST_Transform(ST_TileEnvelope(%s, %s, %s), 4326)"
        ]
        lat_lon_fields = "NULL::numeric AS latitude, NULL::numeric AS longitude,"
    elif mode == "snapped" or snapped:
        active_geom = "COALESCE(e.geom_snapped, e.geom)"
        where_clauses = [
            f"{active_geom} && ST_Transform(ST_TileEnvelope(%s, %s, %s), 4326)"
        ]
        lat_lon_fields = f"round(ST_Y({active_geom})::numeric, 6) AS latitude, round(ST_X({active_geom})::numeric, 6) AS longitude,"
    else:
        active_geom = "e.geom"
        where_clauses = [
            f"{active_geom} && ST_Transform(ST_TileEnvelope(%s, %s, %s), 4326)"
        ]
        lat_lon_fields = f"round(ST_Y({active_geom})::numeric, 6) AS latitude, round(ST_X({active_geom})::numeric, 6) AS longitude,"

    where_clauses.append("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)")
    where_params.append(user_id)

    if days in ("__none__", "none", "empty", "false"):
        where_clauses.append("FALSE")
    elif day_list:
        valid_dates = []
        has_null_date = False
        for d in day_list:
            if d in ("None", "null"):
                has_null_date = True
            else:
                valid_dates.append(d)

        date_conditions = []
        if valid_dates:
            date_conditions.append(
                "(e.timestamp::date = ANY(%s::date[]) AND e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day'))"
            )
            where_params.extend([valid_dates, min(valid_dates), max(valid_dates)])
        if has_null_date:
            date_conditions.append("(e.timestamp IS NULL)")

        if date_conditions:
            where_clauses.append(f"({' OR '.join(date_conditions)})")
        else:
            where_clauses.append("FALSE")

    where_sql = " AND ".join(where_clauses)
    params = [z, x, y] + where_params

    if mode == "osm" and z < 15:
        query = f"""
            WITH bounds AS (
                SELECT ST_TileEnvelope(%s, %s, %s) AS geom
            ),
            grouped_lines AS (
                SELECT
                    min(e.epoch_id::text) AS epoch_id,
                    COALESCE(e.timestamp::date::text, 'None') AS day,
                    min(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS timestamp,
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24'), 'None') AS h,
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI'), 'None') AS m,
                    min(COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS'), 'None')) AS s,
                    NULL::numeric AS latitude,
                    NULL::numeric AS longitude,
                    ST_LineMerge(ST_SnapToGrid(ST_Collect(e.geom_line), 0.00001)) AS continuous_geom
                FROM epochs e
                WHERE {where_sql}
                GROUP BY
                    COALESCE(e.timestamp::date::text, 'None'),
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24'), 'None'),
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI'), 'None')
            ),
            tile_features AS (
                SELECT
                    epoch_id, day, timestamp, h, m, s, latitude, longitude,
                    ST_AsMVTGeom(
                        ST_Transform(continuous_geom, 3857),
                        bounds.geom,
                        4096,
                        256,
                        TRUE
                    ) AS geom
                FROM grouped_lines
                CROSS JOIN bounds
                WHERE continuous_geom IS NOT NULL AND NOT ST_IsEmpty(continuous_geom)
            )
            SELECT ST_AsMVT(tile_features, 'gps-track', 4096, 'geom')
            FROM tile_features
            WHERE geom IS NOT NULL;
        """
    else:
        query = f"""
            WITH bounds AS (
                SELECT ST_TileEnvelope(%s, %s, %s) AS geom
            ),
            tile_features AS (
                SELECT
                    e.epoch_id::text AS epoch_id,
                    COALESCE(e.timestamp::date::text, 'None') AS day,
                    to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24'), 'None') AS h,
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI'), 'None') AS m,
                    COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS'), 'None') AS s,
                    {lat_lon_fields}
                    ST_AsMVTGeom(
                        ST_Transform({active_geom}, 3857),
                        bounds.geom,
                        4096,
                        256,
                        TRUE
                    ) AS geom
                FROM epochs e
                CROSS JOIN bounds
                WHERE {where_sql}
            )
            SELECT ST_AsMVT(tile_features, 'gps-track', 4096, 'geom')
            FROM tile_features
            WHERE geom IS NOT NULL;
        """

    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL max_parallel_workers_per_gather = 0")
                cur.execute(query, params)
                tile = cur.fetchone()[0] or b""
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return Response(
            content=b"",
            media_type="application/vnd.mapbox-vector-tile",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )

    tile_bytes = bytes(tile)
    put_in_tile_cache(cache_key, tile_bytes)

    return Response(
        content=tile_bytes,
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "Cache-Control": "public, max-age=1800, stale-while-revalidate=3600",
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.get("/api/epoch/{epoch_id}")
def get_epoch_details(epoch_id: str, token: Optional[str] = Query(None), authorization: Optional[str] = Header(None)):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return {"error": "Brak autoryzacji"}

    query = """
    SELECT json_build_object(
        'epoch_id', e.epoch_id,
        'profile_id', e.profile_id,
        'timestamp', e.timestamp,
        'latitude', round(ST_Y(e.geom)::numeric, 6),
        'longitude', round(ST_X(e.geom)::numeric, 6),
        'snapped_latitude', CASE WHEN e.geom_snapped IS NOT NULL THEN round(ST_Y(e.geom_snapped)::numeric, 6) ELSE NULL END,
        'snapped_longitude', CASE WHEN e.geom_snapped IS NOT NULL THEN round(ST_X(e.geom_snapped)::numeric, 6) ELSE NULL END,
        'altitude', NULL,
        'speed_kmh', LEAST(COALESCE(e.speed_kmh, 0), 220.0),
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
    WHERE e.epoch_id = %(eid)s
      AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %(uid)s::uuid);
    """
    with get_db() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, {"eid": epoch_id, "uid": user_id})
            row = cur.fetchone()
            if not row or not row["epoch"]:
                return {"error": "Epoch not found"}
            return row["epoch"]


@app.get("/api/playback-day")
def get_playback_day(
    day: str = Query(...),
    snapped: bool = Query(False),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None)
):
    """Pobiera uporządkowaną listę epok telemetrycznych dla wybranego dnia z satelitami (zoptymalizowana wersja JSON)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return Response(content="[]", media_type="application/json")

    day_str = day.strip()
    if day_str in ("None", "null"):
        where_time = "e.timestamp IS NULL"
        query_params = (user_id,)
        order_clause = "e.epoch_id ASC"
    else:
        try:
            datetime.strptime(day_str, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None.")
        where_time = "e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')"
        query_params = (user_id, day_str, day_str)
        order_clause = "e.timestamp ASC"

    active_geom = "COALESCE(e.geom_snapped, e.geom)" if snapped else "e.geom"

    query = f"""
    WITH day_epochs AS (
        SELECT 
            e.epoch_id,
            to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
            round(ST_Y({active_geom})::numeric, 6) AS lat,
            round(ST_X({active_geom})::numeric, 6) AS lon,
            NULL::numeric AS altitude,
            LEAST(COALESCE(e.speed_kmh, 0), 220.0) AS speed_kmh,
            e.g_x,
            e.g_y,
            e.g_z
        FROM epochs e
        WHERE e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)
          AND {where_time}
        ORDER BY {order_clause}
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
        ) ORDER BY {order_clause}
    )::text, '[]')
    FROM day_epochs de
    LEFT JOIN day_satellites ds ON de.epoch_id = ds.epoch_id;
    """
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(query, query_params)
                row = cur.fetchone()
                raw_json = row[0] if (row and row[0]) else "[]"
                return Response(
                    content=raw_json,
                    media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"},
                )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd bazy danych: {str(e)}")


def build_scope_filter(scope: str, day: Optional[str] = None, year: Optional[int] = None, month: Optional[int] = None, days: Optional[str] = None, user_id: Optional[str] = None):
    where_clauses = []
    params = []
    scope_name = "trasa"

    if user_id:
        where_clauses.append("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)")
        params.append(user_id)
    else:
        where_clauses.append("FALSE")

    if scope == "day" and day:
        day_str = day.strip()
        if day_str in ("None", "null"):
            where_clauses.append("e.timestamp IS NULL")
            scope_name = "dzien_None"
        else:
            where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')")
            params.extend([day_str, day_str])
            scope_name = f"dzien_{day_str}"
    elif scope == "month" and year and month:
        start_date = f"{int(year):04d}-{int(month):02d}-01"
        where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 month')")
        params.extend([start_date, start_date])
        scope_name = f"miesiac_{int(year):04d}_{int(month):02d}"
    elif scope == "year" and year:
        start_date = f"{int(year):04d}-01-01"
        where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 year')")
        params.extend([start_date, start_date])
        scope_name = f"rok_{int(year):04d}"
    elif (scope in ("days", "custom", "active")) and days:
        day_list = [d.strip() for d in days.split(",") if d.strip()]
        if day_list:
            valid_dates = [d for d in day_list if d not in ("None", "null")]
            has_null = any(d in ("None", "null") for d in day_list)
            conds = []
            if valid_dates:
                conds.append("e.timestamp::date = ANY(%s::date[])")
                params.append(valid_dates)
            if has_null:
                conds.append("e.timestamp IS NULL")
            if conds:
                where_clauses.append(f"({' OR '.join(conds)})")
            scope_name = f"wybrane_{len(day_list)}_dni"
    elif scope == "all":
        scope_name = "wszystko"
    else:
        if day:
            day_str = day.strip()
            if day_str in ("None", "null"):
                where_clauses.append("e.timestamp IS NULL")
                scope_name = "dzien_None"
            else:
                where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')")
                params.extend([day_str, day_str])
                scope_name = f"dzien_{day_str}"
        else:
            scope_name = "wszystko"

    return where_clauses, params, scope_name


@app.get("/api/export-data")
def get_export_data(
    scope: str = Query("day"),
    day: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    days: Optional[str] = Query(None),
    downsample: Optional[int] = Query(None),
    snapped: bool = Query(False),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Pobiera dane telemetryczne trasy dla zadanego zakresu (dzień, miesiąc, rok, wybrane dni, wszystko)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return Response(content="[]", media_type="application/json")

    where_clauses, params, scope_name = build_scope_filter(scope, day, year, month, days, user_id=user_id)
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    step = int(downsample) if downsample and downsample > 1 else 1
    active_geom = "COALESCE(e.geom_snapped, e.geom)" if snapped else "e.geom"

    if step > 1:
        query = f"""
        WITH numbered AS (
            SELECT 
                e.epoch_id,
                to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
                round(ST_Y({active_geom})::numeric, 6) AS lat,
                round(ST_X({active_geom})::numeric, 6) AS lon,
                NULL::numeric AS altitude,
                LEAST(COALESCE(e.speed_kmh, 0), 220.0) AS speed_kmh,
                e.g_x,
                e.g_y,
                e.g_z,
                ROW_NUMBER() OVER (ORDER BY e.timestamp ASC NULLS LAST, e.epoch_id ASC) AS rn
            FROM epochs e
            {where_sql}
        )
        SELECT COALESCE(json_agg(
            json_build_object(
                'epoch_id', n.epoch_id,
                'timestamp', n.timestamp,
                'lat', n.lat,
                'lon', n.lon,
                'altitude', n.altitude,
                'speed_kmh', n.speed_kmh,
                'g_x', n.g_x,
                'g_y', n.g_y,
                'g_z', n.g_z
            ) ORDER BY n.rn ASC
        )::text, '[]')
        FROM numbered n
        WHERE (n.rn - 1) % {step} = 0;
        """
    else:
        query = f"""
        SELECT COALESCE(json_agg(
            json_build_object(
                'epoch_id', e.epoch_id,
                'timestamp', to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'lat', round(ST_Y({active_geom})::numeric, 6),
                'lon', round(ST_X({active_geom})::numeric, 6),
                'altitude', NULL,
                'speed_kmh', LEAST(COALESCE(e.speed_kmh, 0), 220.0),
                'g_x', e.g_x,
                'g_y', e.g_y,
                'g_z', e.g_z
            ) ORDER BY e.timestamp ASC NULLS LAST, e.epoch_id ASC
        )::text, '[]')
        FROM epochs e
        {where_sql};
        """

    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                row = cur.fetchone()
                raw_json = row[0] if (row and row[0]) else "[]"
                return Response(
                    content=raw_json,
                    media_type="application/json",
                    headers={"Cache-Control": "public, max-age=600"},
                )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd pobierania danych trasy: {str(e)}")


@app.get("/api/export/download")
def download_export_file(
    format: str = Query("gpx"),
    scope: str = Query("day"),
    day: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    days: Optional[str] = Query(None),
    snapped: bool = Query(False),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Generuje i zwraca bezpośrednio plik eksportu (GPX, CSV, GeoJSON, KML)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Brak autoryzacji")

    where_clauses, params, scope_name = build_scope_filter(scope, day, year, month, days, user_id=user_id)
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    active_geom = "COALESCE(e.geom_snapped, e.geom)" if snapped else "e.geom"

    query = f"""
        SELECT 
            to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
            round(ST_Y({active_geom})::numeric, 6) AS lat,
            round(ST_X({active_geom})::numeric, 6) AS lon,
            NULL::numeric AS altitude,
            LEAST(COALESCE(e.speed_kmh, 0), 220.0) AS speed_kmh,
            e.g_x,
            e.g_y,
            e.g_z
        FROM epochs e
        {where_sql}
        ORDER BY e.timestamp ASC NULLS LAST, e.epoch_id ASC;
    """
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd bazy danych: {str(e)}")

    fmt = format.lower().strip()
    filename_base = f"trasa_{scope_name}"

    if fmt == "csv":
        output = ["timestamp,latitude,longitude,altitude_m,speed_kmh,g_x,g_y,g_z"]
        for r in rows:
            ts = r["timestamp"] if r["timestamp"] is not None else ""
            alt = r["altitude"] if r["altitude"] is not None else ""
            spd = r["speed_kmh"] if r["speed_kmh"] is not None else 0
            gx = r["g_x"] if r["g_x"] is not None else ""
            gy = r["g_y"] if r["g_y"] is not None else ""
            gz = r["g_z"] if r["g_z"] is not None else ""
            output.append(f'{ts},{r["lat"]},{r["lon"]},{alt},{spd},{gx},{gy},{gz}')
        content = "\ufeff" + "\n".join(output)
        return Response(
            content=content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.csv"'}
        )

    elif fmt == "gpx":
        lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<gpx version="1.1" creator="NNAPER" xmlns="http://www.topografix.com/GPX/1/1">',
            f'  <metadata><name>Trasa {scope_name}</name></metadata>',
            '  <trk>',
            f'    <name>Trasa NNAPER - {scope_name}</name>',
            '    <trkseg>'
        ]
        for r in rows:
            lines.append(f'      <trkpt lat="{r["lat"]}" lon="{r["lon"]}">')
            if r["altitude"] is not None:
                lines.append(f'        <ele>{r["altitude"]}</ele>')
            if r["timestamp"]:
                lines.append(f'        <time>{r["timestamp"]}</time>')
            if r["speed_kmh"] is not None:
                speed_ms = round(float(r["speed_kmh"]) / 3.6, 2)
                lines.append(f'        <speed>{speed_ms}</speed>')
            lines.append('      </trkpt>')
        lines.append('    </trkseg>')
        lines.append('  </trk>')
        lines.append('</gpx>')
        return Response(
            content="\n".join(lines),
            media_type="application/gpx+xml; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.gpx"'}
        )

    elif fmt == "kml":
        coords_str = " ".join([f'{r["lon"]},{r["lat"]},{r["altitude"] or 0}' for r in rows])
        kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Trasa NNAPER - {scope_name}</name>
    <Style id="routeStyle">
      <LineStyle>
        <color>ff00d406</color>
        <width>4</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>{scope_name}</name>
      <styleUrl>#routeStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>{coords_str}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""
        return Response(
            content=kml,
            media_type="application/vnd.google-earth.kml+xml; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.kml"'}
        )

    elif fmt == "geojson":
        features = [
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[r["lon"], r["lat"], r["altitude"] or 0] for r in rows]
                },
                "properties": {
                    "name": f"Trasa {scope_name}",
                    "points_count": len(rows)
                }
            }
        ]
        geojson_data = {
            "type": "FeatureCollection",
            "features": features
        }
        return Response(
            content=json.dumps(geojson_data, ensure_ascii=False),
            media_type="application/geo+json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.geojson"'}
        )

    else:
        raise HTTPException(status_code=400, detail=f"Nieobsługiwany format: {fmt}")

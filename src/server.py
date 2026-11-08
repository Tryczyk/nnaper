from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime
import json
import threading
import os
from pathlib import Path
import tempfile
import urllib.parse
import uuid
from typing import Optional, List
from fastapi import FastAPI, Query, HTTPException, Header, Request
from fastapi.responses import Response, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
import hashlib
import secrets
from pydantic import BaseModel

from constants import DB_URL, CORS_ORIGINS, DATA_DIR_PATH
from upload_parser import parse_file_disk_stream

UPLOAD_DIR = DATA_DIR_PATH / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_FILE = DATA_DIR_PATH / "parsed_history.json"

PARSER_JOBS = {}
PARSER_JOBS_LOCK = threading.Lock()

def get_user_history(user_id: str) -> dict:
    with PARSER_JOBS_LOCK:
        if HISTORY_FILE.exists():
            try:
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data.get(str(user_id), {})
            except Exception:
                pass
        return {}

def record_user_file_parsed(user_id: str, filename: str, size: int, epochs: int, profile_id: str = None, profile_name: str = None):
    with PARSER_JOBS_LOCK:
        data = {}
        if HISTORY_FILE.exists():
            try:
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                data = {}
        user_key = str(user_id)
        if user_key not in data:
            data[user_key] = {}
        data[user_key][filename] = {
            "name": filename,
            "size": size,
            "epochs": epochs,
            "profile_id": profile_id,
            "profile_name": profile_name,
            "parsed_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

def run_background_parse_job(job_id: str, file_path_str: str, filename: str, user_id: str, profile_id: str, snap: bool):
    file_path = Path(file_path_str)
    try:
        file_size = file_path.stat().st_size if file_path.exists() else 0
        with PARSER_JOBS_LOCK:
            job = PARSER_JOBS.get(job_id)
            if job:
                job["status"] = "running"
                job["stage"] = "parsing"
                job["message"] = "Parsowanie na serwerze..."
                job["updated_at"] = datetime.now(timezone.utc).isoformat()

        with get_db() as conn:
            with conn.cursor() as cur:
                for event in parse_file_disk_stream(
                    file_path,
                    filename,
                    profile_id,
                    cur,
                    conn,
                    snap_to_roads=snap,
                    abort_check=lambda: PARSER_JOBS.get(job_id, {}).get("abort_requested", False),
                ):
                    with PARSER_JOBS_LOCK:
                        job = PARSER_JOBS.get(job_id)
                        if not job or job.get("abort_requested"):
                            break
                        ev_type = event.get("type")
                        if ev_type == "progress":
                            job["percent"] = event.get("percent", job["percent"])
                            job["stage"] = event.get("stage", job["stage"])
                            job["lines"] = event.get("lines", job["lines"])
                            job["epochs"] = event.get("epochs", job["epochs"])
                            job["satellites"] = event.get("satellites", job["satellites"])
                            job["eta_str"] = event.get("eta_str", job["eta_str"])
                            job["speed_mb_s"] = event.get("speed_mb_s", job["speed_mb_s"])
                            job["message"] = event.get("message", job["message"])
                            job["updated_at"] = datetime.now(timezone.utc).isoformat()
                        elif ev_type == "done":
                            job["status"] = "done"
                            job["percent"] = 100
                            job["stage"] = "done"
                            job["epochs"] = event.get("epochs", job["epochs"])
                            job["satellites"] = event.get("satellites", job["satellites"])
                            job["message"] = event.get("message", "Zakończono pomyślnie.")
                            job["eta_str"] = "00:00"
                            job["updated_at"] = datetime.now(timezone.utc).isoformat()
                            record_user_file_parsed(
                                user_id,
                                filename,
                                file_size,
                                job["epochs"],
                                profile_id=profile_id,
                                profile_name=job.get("profile_name") if job else None,
                            )
                        elif ev_type == "error":
                            job["status"] = "error"
                            job["error"] = event.get("message", "Błąd parsowania")
                            job["message"] = event.get("message", "Błąd parsowania")
                            job["updated_at"] = datetime.now(timezone.utc).isoformat()

                clear_tile_cache()
    except Exception as exc:
        with PARSER_JOBS_LOCK:
            job = PARSER_JOBS.get(job_id)
            if job:
                job["status"] = "error"
                job["error"] = str(exc)
                job["message"] = f"Błąd zadania: {str(exc)}"
                job["updated_at"] = datetime.now(timezone.utc).isoformat()
    finally:
        try:
            if file_path.exists():
                file_path.unlink(missing_ok=True)
        except Exception:
            pass

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
                cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_profile_id ON epochs (profile_id);")
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


class CreateProfileRequest(BaseModel):
    name: str


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


@app.get("/api/auth/profiles")
def list_user_profiles(
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Wymagane logowanie.")

    with get_db() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""
                SELECT 
                    p.profile_id,
                    p.user_id,
                    p.name,
                    p.avatar_url,
                    p.created_at,
                    COALESCE(count(e.epoch_id), 0) AS epochs_count,
                    COALESCE(count(DISTINCT e.timestamp::date), 0) AS days_count
                FROM profiles p
                LEFT JOIN epochs e ON p.profile_id = e.profile_id
                WHERE p.user_id = %s::uuid
                GROUP BY p.profile_id, p.user_id, p.name, p.avatar_url, p.created_at
                ORDER BY p.created_at ASC
            """, (user_id,))
            profiles = cur.fetchall()

            if not profiles:
                cur.execute("""
                    INSERT INTO profiles (user_id, name)
                    VALUES (%s::uuid, 'Główny')
                    RETURNING profile_id, user_id, name, avatar_url, created_at
                """, (user_id,))
                new_p = cur.fetchone()
                conn.commit()
                new_p["epochs_count"] = 0
                new_p["days_count"] = 0
                profiles = [new_p]

            result = []
            for p in profiles:
                result.append({
                    "profile_id": str(p["profile_id"]),
                    "user_id": str(p["user_id"]),
                    "name": p["name"],
                    "avatar_url": p.get("avatar_url"),
                    "created_at": p["created_at"].isoformat() if p.get("created_at") else None,
                    "epochs_count": int(p.get("epochs_count", 0)),
                    "days_count": int(p.get("days_count", 0)),
                })
            return result


@app.post("/api/auth/profiles")
def create_user_profile(
    req: CreateProfileRequest,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Wymagane logowanie.")

    name = req.name.strip()
    if not name or len(name) > 64:
        raise HTTPException(status_code=400, detail="Nazwa profilu musi mieć od 1 do 64 znaków.")

    with get_db() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("""
                SELECT profile_id FROM profiles
                WHERE user_id = %s::uuid AND LOWER(name) = LOWER(%s)
            """, (user_id, name))
            if cur.fetchone():
                raise HTTPException(status_code=400, detail="Profil o takiej nazwie już istnieje.")

            cur.execute("""
                INSERT INTO profiles (user_id, name)
                VALUES (%s::uuid, %s)
                RETURNING profile_id, user_id, name, avatar_url, created_at
            """, (user_id, name))
            new_p = cur.fetchone()
            conn.commit()

            return {
                "status": "ok",
                "profile": {
                    "profile_id": str(new_p["profile_id"]),
                    "user_id": str(new_p["user_id"]),
                    "name": new_p["name"],
                    "avatar_url": new_p.get("avatar_url"),
                    "created_at": new_p["created_at"].isoformat() if new_p.get("created_at") else None,
                    "epochs_count": 0,
                    "days_count": 0,
                }
            }


@app.delete("/api/auth/profiles/{profile_id}")
def delete_user_profile(
    profile_id: str,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Wymagane logowanie.")

    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM profiles WHERE user_id = %s::uuid", (user_id,))
            count = cur.fetchone()[0]
            if count <= 1:
                raise HTTPException(status_code=400, detail="Nie możesz usunąć jedynego profilu konta.")

            cur.execute("""
                DELETE FROM profiles
                WHERE profile_id = %s::uuid AND user_id = %s::uuid
                RETURNING profile_id
            """, (profile_id, user_id))
            deleted = cur.fetchone()
            if not deleted:
                raise HTTPException(status_code=404, detail="Profil nie został odnaleziony.")
            conn.commit()

    with tile_cache_lock:
        tile_cache.clear()

    return {"status": "ok", "message": "Profil oraz powiązane z nim ślady zostały usunięte."}


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
def get_dates_tree(
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    profile_id: Optional[str] = Query(None),
):
    user_id = get_auth_user_id(token, authorization)

    valid_profile_uuid = None
    if profile_id and str(profile_id).strip() not in ("all", "__all__", "", "undefined", "null", "None"):
        try:
            valid_profile_uuid = str(uuid.UUID(str(profile_id).strip()))
        except (ValueError, AttributeError):
            valid_profile_uuid = None

    if user_id:
        if valid_profile_uuid:
            where_profile = "e.profile_id = %s::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
            prof_params = (valid_profile_uuid, user_id)
        else:
            where_profile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
            prof_params = (user_id,)
    else:
        if valid_profile_uuid:
            where_profile = "e.profile_id = %s::uuid"
            prof_params = (valid_profile_uuid,)
        else:
            where_profile = "1=1"
            prof_params = ()

    query = f"""
        SELECT DISTINCT 
            EXTRACT(YEAR FROM e.timestamp)::int AS y,
            EXTRACT(MONTH FROM e.timestamp)::int AS m,
            EXTRACT(DAY FROM e.timestamp)::int AS d
        FROM epochs e
        WHERE {where_profile}
        ORDER BY y DESC NULLS LAST, m DESC NULLS LAST, d DESC NULLS LAST;
    """
    tree = {}
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(query, prof_params)
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
    except Exception as exc:
        print(f"[ERROR /api/dates-tree] {exc}")
        return {}
    return tree


@app.get("/api/time-tree")
def get_time_tree(
    day: str = Query(...),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    profile_id: Optional[str] = Query(None),
):
    """Pobiera dynamicznie strukturę godzin, minut i sekund dla wybranego dnia (lub None)."""
    user_id = get_auth_user_id(token, authorization)

    valid_profile_uuid = None
    if profile_id and str(profile_id).strip() not in ("all", "__all__", "", "undefined", "null", "None"):
        try:
            valid_profile_uuid = str(uuid.UUID(str(profile_id).strip()))
        except (ValueError, AttributeError):
            valid_profile_uuid = None

    if user_id:
        if valid_profile_uuid:
            where_profile = "e.profile_id = %s::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
            prof_params = [valid_profile_uuid, user_id]
        else:
            where_profile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
            prof_params = [user_id]
    else:
        if valid_profile_uuid:
            where_profile = "e.profile_id = %s::uuid"
            prof_params = [valid_profile_uuid]
        else:
            where_profile = "1=1"
            prof_params = []

    day_str = day.strip()
    if day_str in ("None", "null"):
        where_time = "e.timestamp IS NULL"
        params = tuple(prof_params)
    else:
        try:
            datetime.strptime(day_str, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None.")
        where_time = "e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')"
        params = tuple(prof_params + [day_str, day_str])

    query = f"""
        SELECT DISTINCT 
            to_char(e.timestamp, 'HH24') AS h,
            to_char(e.timestamp, 'MI') AS mi,
            to_char(e.timestamp, 'SS') AS s
        FROM epochs e
        WHERE {where_profile}
          AND {where_time}
        ORDER BY h DESC NULLS LAST, mi DESC NULLS LAST, s DESC NULLS LAST;
    """
    tree = {}
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                for h, mi, s in cur.fetchall():
                    h_str = h if h is not None else "None"
                    mi_str = mi if mi is not None else "None"
                    s_str = s if s is not None else "None"
                    tree.setdefault(h_str, {}).setdefault(mi_str, []).append(s_str)
    except Exception as exc:
        print(f"[ERROR /api/time-tree] {exc}")
        return {}
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
    profile_id: Optional[str] = Query(None),
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

    cache_key = (user_id, profile_id, z, x, y, days, snapped, mode)
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

    if profile_id and profile_id not in ("all", "__all__", ""):
        where_clauses.append("e.profile_id = %s::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)")
        where_params.extend([profile_id, user_id])
    else:
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


@app.delete("/api/epoch/{epoch_id}")
def delete_epoch(
    epoch_id: str,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Trwale usuwa pojedynczy punkt GPS (epokę) z bazy danych wraz z powiązanymi satelitami."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Brak autoryzacji")

    query = """
        DELETE FROM epochs
        WHERE epoch_id = %(eid)s::uuid
          AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %(uid)s::uuid)
        RETURNING epoch_id;
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, {"eid": epoch_id, "uid": user_id})
            deleted = cur.fetchone()
            if not deleted:
                raise HTTPException(status_code=404, detail="Punkt nie istnieje lub brak uprawnień do jego usunięcia")
            conn.commit()

    with tile_cache_lock:
        tile_cache.clear()

    return {"success": True, "message": "Punkt został trwale usunięty z bazy", "epoch_id": epoch_id}


@app.delete("/api/epochs/day")
def delete_epochs_by_day(
    day: str = Query(..., description="Data w formacie YYYY-MM-DD lub 'None'"),
    profile_id: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Trwale usuwa wszystkie punkty GPS z wybranego dnia dla danego profilu (lub wszystkich profili użytkownika)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Brak autoryzacji")

    if profile_id and profile_id not in ("all", "__all__", ""):
        where_profile = "profile_id = %s::uuid AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
        prof_params = [profile_id, user_id]
    else:
        where_profile = "profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
        prof_params = [user_id]

    day_str = day.strip()
    if day_str in ("None", "null"):
        where_time = "timestamp IS NULL"
        params = tuple(prof_params)
    else:
        try:
            datetime.strptime(day_str, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None.")
        where_time = "timestamp >= %s::date AND timestamp < (%s::date + INTERVAL '1 day')"
        params = tuple(prof_params + [day_str, day_str])

    query = f"""
        DELETE FROM epochs
        WHERE {where_profile}
          AND {where_time}
        RETURNING epoch_id;
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            deleted_rows = cur.fetchall()
            count = len(deleted_rows)
            conn.commit()

    with tile_cache_lock:
        tile_cache.clear()

    return {"success": True, "deleted_count": count, "day": day_str}


class BatchDeletePayload(BaseModel):
    epoch_ids: List[str]


@app.post("/api/epochs/delete-batch")
def delete_epochs_batch(
    payload: BatchDeletePayload,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    """Trwale usuwa listę punktów GPS (epok) po ich ID dla zalogowanego użytkownika."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Brak autoryzacji")

    if not payload.epoch_ids:
        return {"success": True, "deleted_count": 0}

    query = """
        DELETE FROM epochs
        WHERE epoch_id = ANY(%s::uuid[])
          AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)
        RETURNING epoch_id;
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(query, (payload.epoch_ids, user_id))
            deleted_rows = cur.fetchall()
            count = len(deleted_rows)
            conn.commit()

    with tile_cache_lock:
        tile_cache.clear()

    return {"success": True, "deleted_count": count}


@app.get("/api/playback-day")
def get_playback_day(
    day: str = Query(...),
    snapped: bool = Query(False),
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    profile_id: Optional[str] = Query(None),
):
    """Pobiera uporządkowaną listę epok telemetrycznych dla wybranego dnia z satelitami (zoptymalizowana wersja JSON)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return Response(content="[]", media_type="application/json")

    if profile_id and profile_id not in ("all", "__all__", ""):
        where_profile = "e.profile_id = %s::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
        prof_params = [profile_id, user_id]
    else:
        where_profile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)"
        prof_params = [user_id]

    day_str = day.strip()
    if day_str in ("None", "null"):
        where_time = "e.timestamp IS NULL"
        query_params = tuple(prof_params)
        order_clause = "e.epoch_id ASC"
    else:
        try:
            datetime.strptime(day_str, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None.")
        where_time = "e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')"
        query_params = tuple(prof_params + [day_str, day_str])
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
        WHERE {where_profile}
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


def build_scope_filter(scope: str, day: Optional[str] = None, year: Optional[int] = None, month: Optional[int] = None, days: Optional[str] = None, user_id: Optional[str] = None, profile_id: Optional[str] = None):
    where_clauses = []
    params = []
    scope_name = "trasa"

    if user_id:
        if profile_id and profile_id not in ("all", "__all__", ""):
            where_clauses.append("e.profile_id = %s::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = %s::uuid)")
            params.extend([profile_id, user_id])
        else:
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
    profile_id: Optional[str] = Query(None),
):
    """Pobiera dane telemetryczne trasy dla zadanego zakresu (dzień, miesiąc, rok, wybrane dni, wszystko)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return Response(content="[]", media_type="application/json")

    where_clauses, params, scope_name = build_scope_filter(scope, day, year, month, days, user_id=user_id, profile_id=profile_id)
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
    profile_id: Optional[str] = Query(None),
):
    """Generuje i zwraca bezpośrednio plik eksportu (GPX, CSV, GeoJSON, KML)."""
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Brak autoryzacji")

    where_clauses, params, scope_name = build_scope_filter(scope, day, year, month, days, user_id=user_id, profile_id=profile_id)
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


@app.post("/api/parser/upload")
async def upload_and_start_job(
    request: Request,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    snap: bool = Query(True),
    filename: Optional[str] = Query(None),
    x_filename: Optional[str] = Header(None),
    profile_id: Optional[str] = Query(None),
):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Musisz być zalogowany, aby importować dane GPS.")

    raw_fname = filename or x_filename or "plik.txt"
    try:
        real_filename = urllib.parse.unquote(raw_fname)
    except Exception:
        real_filename = raw_fname

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    saved_path = UPLOAD_DIR / f"{user_id}_{job_id}_{real_filename}"

    try:
        with open(str(saved_path), "wb") as tf:
            async for chunk in request.stream():
                if chunk:
                    tf.write(chunk)
    except Exception as e:
        if saved_path.exists():
            try:
                saved_path.unlink(missing_ok=True)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Błąd zapisu pliku: {str(e)}")

    # Pobranie lub utworzenie profilu
    target_profile_id = None
    target_profile_name = None
    with get_db() as conn:
        with conn.cursor() as cur:
            if profile_id and profile_id not in ("all", "__all__", ""):
                cur.execute(
                    "SELECT profile_id, name FROM profiles WHERE profile_id = %s::uuid AND user_id = %s::uuid",
                    (profile_id, user_id),
                )
                p_row = cur.fetchone()
                if p_row:
                    target_profile_id = str(p_row[0])
                    target_profile_name = str(p_row[1])

            if not target_profile_id:
                cur.execute(
                    "SELECT profile_id, name FROM profiles WHERE user_id = %s::uuid ORDER BY created_at ASC LIMIT 1",
                    (user_id,),
                )
                row = cur.fetchone()
                if row:
                    target_profile_id = str(row[0])
                    target_profile_name = str(row[1])
                else:
                    cur.execute(
                        "INSERT INTO profiles (user_id, name) VALUES (%s::uuid, 'Główny') RETURNING profile_id, name",
                        (user_id,),
                    )
                    ins_row = cur.fetchone()
                    target_profile_id = str(ins_row[0])
                    target_profile_name = str(ins_row[1])
                    conn.commit()

    file_size = saved_path.stat().st_size if saved_path.exists() else 0

    job_record = {
        "job_id": job_id,
        "user_id": str(user_id),
        "profile_id": str(target_profile_id),
        "profile_name": target_profile_name,
        "filename": real_filename,
        "file_size": file_size,
        "status": "queued",
        "stage": "queued",
        "percent": 0,
        "lines": 0,
        "epochs": 0,
        "satellites": 0,
        "eta_str": "--:--",
        "speed_mb_s": 0.0,
        "message": f"Plik przesłany. Zadanie przypisane do profilu '{target_profile_name}' oczekuje w kolejce...",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "abort_requested": False,
        "error": None,
    }

    with PARSER_JOBS_LOCK:
        PARSER_JOBS[job_id] = job_record

    # Uruchomienie parsowania asynchronicznie w tle na serwerze!
    worker_thread = threading.Thread(
        target=run_background_parse_job,
        args=(job_id, str(saved_path), real_filename, str(user_id), str(target_profile_id), snap),
        daemon=True,
    )
    worker_thread.start()

    return JSONResponse({
        "status": "ok",
        "job_id": job_id,
        "job": job_record,
        "message": "Plik został pomyślnie przesłany i jest przetwarzany w tle na serwerze."
    })


@app.get("/api/parser/jobs")
def get_parser_jobs(
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        return JSONResponse({"active_jobs": [], "jobs": [], "history": {}})

    with PARSER_JOBS_LOCK:
        user_jobs = [
            j for j in PARSER_JOBS.values()
            if j.get("user_id") == str(user_id)
        ]
        user_jobs_sorted = sorted(user_jobs, key=lambda x: x.get("created_at", ""), reverse=True)[:20]

    history = get_user_history(user_id)
    return JSONResponse({
        "jobs": user_jobs_sorted,
        "active_jobs": [j for j in user_jobs_sorted if j.get("status") in ("queued", "running")],
        "history": history
    })


@app.post("/api/parser/job/{job_id}/abort")
def abort_parser_job(
    job_id: str,
    token: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
):
    user_id = get_auth_user_id(token, authorization)
    if not user_id:
        raise HTTPException(status_code=401, detail="Wymagane logowanie.")

    with PARSER_JOBS_LOCK:
        job = PARSER_JOBS.get(job_id)
        if not job or job.get("user_id") != str(user_id):
            raise HTTPException(status_code=404, detail="Zadanie nie zostało znalezione.")
        job["abort_requested"] = True
        job["status"] = "error"
        job["message"] = "Przerwano na życzenie użytkownika."
        job["updated_at"] = datetime.now(timezone.utc).isoformat()

    return JSONResponse({"status": "ok", "message": "Zadanie zostało przerwane."})




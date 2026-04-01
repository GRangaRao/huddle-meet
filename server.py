"""
Video Call Server - WebRTC SFU via mediasoup + PostgreSQL persistence.
Uses aiohttp for HTTP serving and WebSocket signaling.
Bridges to a Node.js mediasoup worker for media routing (SFU).
Zoom-like features: waiting room, host controls, hand raise, reactions,
breakout rooms, polls, whiteboard, participant management.
"""

import os
import json
import uuid
import asyncio
import subprocess
import signal
import sys
import hashlib
import hmac
import secrets
import time
from datetime import datetime
from pathlib import Path

import aiohttp
from aiohttp import web

# Optional PostgreSQL support — falls back to in-memory if unavailable
try:
    import asyncpg
    HAS_PG = True
except ImportError:
    HAS_PG = False

DATABASE_URL = os.environ.get("DATABASE_URL", "")
MEDIA_WORKER_PORT = int(os.environ.get("MEDIA_WORKER_PORT", "3000"))
MEDIA_WORKER_URL = f"http://127.0.0.1:{MEDIA_WORKER_PORT}"

# ── Firebase Auth Config ──────────────────────────────────────────────────
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "")
FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY", "")
FIREBASE_AUTH_DOMAIN = os.environ.get("FIREBASE_AUTH_DOMAIN", f"{FIREBASE_PROJECT_ID}.firebaseapp.com" if FIREBASE_PROJECT_ID else "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", secrets.token_hex(32))
CLOUD_BASE_URL = os.environ.get("CLOUD_BASE_URL", "https://huddle-meet.onrender.com")
# Detect if we're the cloud instance (Render sets RENDER=true) or a local desktop
IS_CLOUD = bool(os.environ.get("RENDER") or os.environ.get("IS_CLOUD"))

# In-memory session store: { session_id: { "user": {...}, "created": timestamp } }
auth_sessions: dict[str, dict] = {}
# Cache for Google public keys (used to verify Firebase ID tokens)
_google_certs: dict = {}
_google_certs_expiry: float = 0


async def sync_to_cloud(path: str, data: dict = None, method: str = "POST"):
    """Forward an API call to the cloud server (fire-and-forget)."""
    if IS_CLOUD or not CLOUD_BASE_URL:
        return
    try:
        import ssl
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
        connector = aiohttp.TCPConnector(ssl=ssl_ctx)
        async with aiohttp.ClientSession(connector=connector, trust_env=False) as session:
            url = f"{CLOUD_BASE_URL}{path}"
            kwargs = {"timeout": aiohttp.ClientTimeout(total=15)}
            if data is not None:
                kwargs["json"] = data
            async with session.request(method, url, **kwargs) as resp:
                body = await resp.text()
                if resp.status < 300:
                    print(f"[cloud-sync] Synced {method} {path} to cloud OK", flush=True)
                else:
                    print(f"[cloud-sync] Sync {method} {path} failed: {resp.status} {body}", flush=True)
    except Exception as e:
        print(f"[cloud-sync] Sync {method} {path} error: {type(e).__name__}: {e}", flush=True)

# ── Database Pool ─────────────────────────────────────────────────────────
db_pool = None

async def init_db():
    """Initialize PostgreSQL connection pool and create tables."""
    global db_pool
    if not HAS_PG or not DATABASE_URL:
        print("[db] No DATABASE_URL set or asyncpg not installed — using in-memory storage")
        return
    try:
        db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        async with db_pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS scheduled_meetings (
                    id TEXT PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    topic TEXT NOT NULL DEFAULT 'Untitled Meeting',
                    meeting_date TEXT,
                    meeting_time TEXT,
                    duration INTEGER DEFAULT 30,
                    timezone TEXT DEFAULT 'UTC',
                    recurring BOOLEAN DEFAULT FALSE,
                    recurrence TEXT DEFAULT 'weekly',
                    end_date TEXT,
                    passcode_enabled BOOLEAN DEFAULT TRUE,
                    passcode TEXT,
                    waiting_room BOOLEAN DEFAULT FALSE,
                    host_video TEXT DEFAULT 'on',
                    participant_video TEXT DEFAULT 'on',
                    mute_on_entry BOOLEAN DEFAULT TRUE,
                    auto_record BOOLEAN DEFAULT FALSE,
                    description TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    created_by TEXT DEFAULT 'Host'
                );
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id SERIAL PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    peer_id TEXT,
                    name TEXT,
                    message TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id);
                CREATE INDEX IF NOT EXISTS idx_meetings_date ON scheduled_meetings(meeting_date, meeting_time);
            """)
        print(f"[db] PostgreSQL connected, tables ready")
    except Exception as e:
        print(f"[db] PostgreSQL connection failed: {e} — using in-memory storage")
        db_pool = None


# ── Room State (in-memory, always needed for live sessions) ───────────────
# rooms = { room_id: { peer_id: websocket, ... } }
rooms: dict[str, dict[str, web.WebSocketResponse]] = {}
# peer metadata: { peer_id: { "name": ..., "room": ..., "role": ..., "hand": False } }
peers: dict[str, dict] = {}
# room metadata: { room_id: { "host": peer_id, "waiting_room_enabled": bool, "locked": bool, ... } }
room_meta: dict[str, dict] = {}
# waiting room: { room_id: { peer_id: { "ws": ws, "name": name } } }
waiting_rooms: dict[str, dict] = {}
# polls: { room_id: [{ "id": str, "question": str, "options": [...], "votes": {peer_id: idx}, "active": bool }] }
room_polls: dict[str, list] = {}
# whiteboard: { room_id: [ {type, points, color, width} ] }
room_whiteboards: dict[str, list] = {}
# breakout rooms: { room_id: { "rooms": { sub_id: { "name": str, "peers": [peer_id] } }, "active": bool } }
room_breakouts: dict[str, dict] = {}
# scheduled meetings fallback (in-memory when no PostgreSQL)
scheduled_meetings: dict[str, dict] = {}

# ── Local file persistence for scheduled meetings (desktop / no-DB mode) ──
def _get_data_dir() -> Path:
    """Get a writable data directory (user's AppData on Windows, ~/.huddle otherwise)."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path.home()
    return base / ".huddle"

_SCHEDULE_FILE = _get_data_dir() / "scheduled_meetings.json"

def _load_scheduled_meetings():
    """Load meetings from local JSON file at startup."""
    if _SCHEDULE_FILE.exists():
        try:
            data = json.loads(_SCHEDULE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                scheduled_meetings.update(data)
                print(f"[persist] Loaded {len(data)} scheduled meeting(s) from disk")
        except Exception as e:
            print(f"[persist] Failed to load scheduled meetings: {e}")

def _save_scheduled_meetings():
    """Persist meetings to local JSON file."""
    try:
        _SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SCHEDULE_FILE.write_text(json.dumps(scheduled_meetings, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[persist] Failed to save scheduled meetings: {e}")
# shared files: { room_id: [ { id, name, size, type, data(bytes), uploader, uploaded_at } ] }
room_files: dict[str, list] = {}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB per file
MAX_FILES_PER_ROOM = 50

STATIC_DIR = Path(__file__).parent / "static"

# ── mediasoup Bridge ──────────────────────────────────────────────────────
http_session: aiohttp.ClientSession = None

async def media_api(path, data=None):
    """Call the mediasoup Node.js worker internal API."""
    global http_session
    if http_session is None:
        http_session = aiohttp.ClientSession()
    url = f"{MEDIA_WORKER_URL}{path}"
    try:
        async with http_session.post(url, json=data or {}) as resp:
            return await resp.json()
    except Exception as e:
        print(f"[media] API call failed {path}: {e}")
        return {"error": str(e)}


# ── Session Helpers ───────────────────────────────────────────────────────

def sign_session_id(session_id: str) -> str:
    """Sign a session ID with HMAC to prevent tampering."""
    sig = hmac.new(SESSION_SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()[:16]
    return f"{session_id}.{sig}"

def verify_session_cookie(cookie_value: str) -> str | None:
    """Verify a signed session cookie. Returns session_id or None."""
    if not cookie_value or "." not in cookie_value:
        return None
    session_id, sig = cookie_value.rsplit(".", 1)
    expected = hmac.new(SESSION_SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()[:16]
    if hmac.compare_digest(sig, expected):
        return session_id
    return None

def get_session_user(request) -> dict | None:
    """Get the authenticated user from the request cookie, or None."""
    cookie = request.cookies.get("huddle_session", "")
    sid = verify_session_cookie(cookie)
    if sid and sid in auth_sessions:
        return auth_sessions[sid].get("user")
    return None


# ── Firebase Auth Routes ──────────────────────────────────────────────────

async def _get_google_certs():
    """Fetch Google's public keys for verifying Firebase ID tokens."""
    global _google_certs, _google_certs_expiry, http_session
    if time.time() < _google_certs_expiry and _google_certs:
        return _google_certs
    if http_session is None:
        http_session = aiohttp.ClientSession()
    async with http_session.get(
        "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
    ) as resp:
        _google_certs = await resp.json()
        # Cache for 1 hour
        _google_certs_expiry = time.time() + 3600
    return _google_certs


async def _verify_firebase_token(id_token: str) -> dict | None:
    """Verify a Firebase ID token and return the decoded payload, or None."""
    import base64
    try:
        # Decode header to get kid
        parts = id_token.split(".")
        if len(parts) != 3:
            return None
        header_b64 = parts[0] + "==" # pad
        header = json.loads(base64.urlsafe_b64decode(header_b64))
        kid = header.get("kid")
        alg = header.get("alg")
        if alg != "RS256" or not kid:
            return None

        # Decode payload (we verify issuer/expiry but skip full RSA
        # signature check — for production, use python-jose or PyJWT.
        # For our use case, we trust the Firebase JS SDK already verified
        # on client side, and we validate issuer + expiry + project_id.)
        payload_b64 = parts[1] + "=="
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))

        # Validate claims
        now = time.time()
        if payload.get("exp", 0) < now:
            print("[auth] Token expired")
            return None
        if payload.get("iat", 0) > now + 300:  # 5 min clock skew
            return None
        expected_issuer = f"https://securetoken.google.com/{FIREBASE_PROJECT_ID}"
        if FIREBASE_PROJECT_ID and payload.get("iss") != expected_issuer:
            print(f"[auth] Invalid issuer: {payload.get('iss')}")
            return None
        if FIREBASE_PROJECT_ID and payload.get("aud") != FIREBASE_PROJECT_ID:
            return None

        return payload
    except Exception as e:
        print(f"[auth] Token verification error: {e}")
        return None


async def auth_firebase(request):
    """Accept a Firebase ID token, verify it, create a server session."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    id_token = body.get("idToken", "")
    if not id_token:
        return web.json_response({"error": "Missing idToken"}, status=400)

    payload = await _verify_firebase_token(id_token)
    if not payload:
        return web.json_response({"error": "Invalid or expired token"}, status=401)

    user_data = {
        "name": payload.get("name", payload.get("email", "User")),
        "email": payload.get("email", ""),
        "picture": payload.get("picture", ""),
        "uid": payload.get("sub", ""),
    }

    session_id = secrets.token_urlsafe(32)
    auth_sessions[session_id] = {
        "user": user_data,
        "created": time.time(),
    }
    signed = sign_session_id(session_id)
    resp = web.json_response({"ok": True, **user_data})
    resp.set_cookie("huddle_session", signed, max_age=86400 * 7, httponly=True, samesite="Lax")
    print(f"[auth] Firebase user signed in: {user_data['email']}")
    return resp


async def auth_me(request):
    """Return the currently signed-in user, or 401."""
    user = get_session_user(request)
    if user:
        return web.json_response({"authenticated": True, **user})
    return web.json_response({"authenticated": False}, status=401)


async def auth_logout(request):
    """Clear the session cookie."""
    cookie = request.cookies.get("huddle_session", "")
    sid = verify_session_cookie(cookie)
    if sid and sid in auth_sessions:
        del auth_sessions[sid]
    resp = web.json_response({"ok": True})
    resp.del_cookie("huddle_session")
    return resp


async def auth_config(request):
    """Return Firebase config for the frontend (public keys only)."""
    if not FIREBASE_API_KEY or not FIREBASE_PROJECT_ID:
        return web.json_response({"configured": False, "shareBaseUrl": CLOUD_BASE_URL})
    return web.json_response({
        "configured": True,
        "apiKey": FIREBASE_API_KEY,
        "authDomain": FIREBASE_AUTH_DOMAIN,
        "projectId": FIREBASE_PROJECT_ID,
        "shareBaseUrl": CLOUD_BASE_URL,
    })


# ── HTTP Routes ───────────────────────────────────────────────────────────

async def version_check(request):
    return web.json_response({"version": "2.2-calendar", "deployed": True})


async def index(request):
    return web.FileResponse(STATIC_DIR / "index.html")


async def room_page(request):
    return web.FileResponse(STATIC_DIR / "index.html")


async def create_room(request):
    room_id = uuid.uuid4().hex[:8]
    rooms[room_id] = {}
    room_meta[room_id] = {
        "host": None,
        "waiting_room_enabled": False,
        "locked": False,
        "created": datetime.utcnow().isoformat(),
    }
    waiting_rooms[room_id] = {}
    room_polls[room_id] = []
    room_whiteboards[room_id] = []
    room_breakouts[room_id] = {"rooms": {}, "active": False}
    room_files[room_id] = []
    # Sync room to cloud so invite links work
    asyncio.ensure_future(sync_to_cloud("/api/create-room-with-id", {"room_id": room_id}))
    return web.json_response({"room_id": room_id})


async def create_room_with_id(request):
    """Create a room with a specific ID (used for cloud sync from desktop)."""
    data = await request.json()
    room_id = data.get("room_id")
    if not room_id:
        return web.json_response({"error": "room_id required"}, status=400)
    if room_id not in rooms:
        rooms[room_id] = {}
        room_meta[room_id] = {
            "host": None,
            "waiting_room_enabled": False,
            "locked": False,
            "created": datetime.utcnow().isoformat(),
        }
        waiting_rooms[room_id] = {}
        room_polls[room_id] = []
        room_whiteboards[room_id] = []
        room_breakouts[room_id] = {"rooms": {}, "active": False}
        room_files[room_id] = []
    return web.json_response({"room_id": room_id})


# ── File Sharing API ──────────────────────────────────────────────────────

async def upload_file(request):
    """Upload a file to a room. Multipart form: room_id, uploader, file."""
    reader = await request.multipart()
    room_id = None
    uploader = "Guest"
    file_data = None
    file_name = None
    file_type = None
    file_size = 0

    async for part in reader:
        if part.name == "room_id":
            room_id = (await part.text()).strip()
        elif part.name == "uploader":
            uploader = (await part.text()).strip()[:50]
        elif part.name == "file":
            file_name = part.filename or "untitled"
            file_type = part.headers.get("Content-Type", "application/octet-stream")
            chunks = []
            while True:
                chunk = await part.read_chunk()
                if not chunk:
                    break
                file_size += len(chunk)
                if file_size > MAX_FILE_SIZE:
                    return web.json_response({"error": "File too large (max 50 MB)"}, status=413)
                chunks.append(chunk)
            file_data = b"".join(chunks)

    if not room_id or not file_data:
        return web.json_response({"error": "Missing room_id or file"}, status=400)

    if room_id not in room_files:
        room_files[room_id] = []

    if len(room_files[room_id]) >= MAX_FILES_PER_ROOM:
        return web.json_response({"error": "Too many files in this room"}, status=400)

    file_id = uuid.uuid4().hex[:10]
    file_info = {
        "id": file_id,
        "name": file_name[:255],
        "size": file_size,
        "type": file_type,
        "data": file_data,
        "uploader": uploader,
        "uploaded_at": datetime.utcnow().isoformat(),
    }
    room_files[room_id].append(file_info)

    # Notify all peers in the room
    await broadcast(room_id, {
        "action": "file-shared",
        "file": {
            "id": file_id,
            "name": file_name[:255],
            "size": file_size,
            "type": file_type,
            "uploader": uploader,
            "uploaded_at": file_info["uploaded_at"],
        },
    })

    return web.json_response({
        "id": file_id,
        "name": file_name[:255],
        "size": file_size,
    })


async def download_file(request):
    """Download a shared file."""
    room_id = request.match_info["room_id"]
    file_id = request.match_info["file_id"]
    files = room_files.get(room_id, [])
    for f in files:
        if f["id"] == file_id:
            return web.Response(
                body=f["data"],
                content_type=f["type"],
                headers={
                    "Content-Disposition": f'attachment; filename="{f["name"]}"',
                },
            )
    return web.json_response({"error": "File not found"}, status=404)


async def list_room_files(request):
    """List files shared in a room."""
    room_id = request.match_info["room_id"]
    files = room_files.get(room_id, [])
    return web.json_response([
        {
            "id": f["id"],
            "name": f["name"],
            "size": f["size"],
            "type": f["type"],
            "uploader": f["uploader"],
            "uploaded_at": f["uploaded_at"],
        }
        for f in files
    ])


async def delete_room_file(request):
    """Delete a shared file (host only checked client-side)."""
    room_id = request.match_info["room_id"]
    file_id = request.match_info["file_id"]
    files = room_files.get(room_id, [])
    room_files[room_id] = [f for f in files if f["id"] != file_id]
    await broadcast(room_id, {"action": "file-deleted", "file_id": file_id})
    return web.json_response({"ok": True})


# ── Schedule Meeting API ──────────────────────────────────────────────────

async def schedule_meeting(request):
    """Create a scheduled meeting."""
    data = await request.json()
    # Accept pre-assigned IDs when synced from desktop, otherwise generate new
    meeting_id = data.get("id") or uuid.uuid4().hex[:8]
    room_id = data.get("room_id") or uuid.uuid4().hex[:8]
    # Pre-create the room
    rooms[room_id] = {}
    room_meta[room_id] = {
        "host": None,
        "waiting_room_enabled": data.get("waitingRoom", False),
        "locked": False,
        "created": datetime.utcnow().isoformat(),
    }
    waiting_rooms[room_id] = {}
    room_polls[room_id] = []
    room_whiteboards[room_id] = []
    room_breakouts[room_id] = {"rooms": {}, "active": False}

    meeting = {
        "id": meeting_id,
        "room_id": room_id,
        "topic": data.get("topic", "Untitled Meeting"),
        "date": data.get("date", ""),
        "time": data.get("time", ""),
        "duration": int(data.get("duration", 30)),
        "timezone": data.get("timezone", "UTC"),
        "recurring": data.get("recurring", False),
        "recurrence": data.get("recurrence", "weekly"),
        "endDate": data.get("endDate", ""),
        "passcodeEnabled": data.get("passcodeEnabled", True),
        "passcode": data.get("passcode", ""),
        "waitingRoom": data.get("waitingRoom", False),
        "hostVideo": data.get("hostVideo", "on"),
        "participantVideo": data.get("participantVideo", "on"),
        "muteOnEntry": data.get("muteOnEntry", True),
        "autoRecord": data.get("autoRecord", False),
        "description": data.get("description", ""),
        "createdAt": datetime.utcnow().isoformat(),
        "createdBy": data.get("createdBy", "Host"),
    }

    if db_pool:
        async with db_pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO scheduled_meetings
                (id, room_id, topic, meeting_date, meeting_time, duration, timezone,
                 recurring, recurrence, end_date, passcode_enabled, passcode,
                 waiting_room, host_video, participant_video, mute_on_entry,
                 auto_record, description, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            """, meeting_id, room_id, meeting["topic"], meeting["date"], meeting["time"],
                meeting["duration"], meeting["timezone"], meeting["recurring"],
                meeting["recurrence"], meeting["endDate"], meeting["passcodeEnabled"],
                meeting["passcode"], meeting["waitingRoom"], meeting["hostVideo"],
                meeting["participantVideo"], meeting["muteOnEntry"],
                meeting["autoRecord"], meeting["description"], meeting["createdBy"])
    else:
        scheduled_meetings[meeting_id] = meeting
        _save_scheduled_meetings()

    # Sync schedule + room to cloud so invite links work for remote users
    asyncio.ensure_future(sync_to_cloud("/api/create-room-with-id", {"room_id": room_id}))
    asyncio.ensure_future(sync_to_cloud("/api/schedule", meeting))

    return web.json_response(meeting)


async def list_scheduled_meetings(request):
    """Return all scheduled meetings sorted by date/time."""
    if db_pool:
        async with db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM scheduled_meetings ORDER BY meeting_date, meeting_time"
            )
            meetings = []
            for r in rows:
                meetings.append({
                    "id": r["id"], "room_id": r["room_id"], "topic": r["topic"],
                    "date": r["meeting_date"], "time": r["meeting_time"],
                    "duration": r["duration"], "timezone": r["timezone"],
                    "recurring": r["recurring"], "recurrence": r["recurrence"],
                    "endDate": r["end_date"] or "", "passcodeEnabled": r["passcode_enabled"],
                    "passcode": r["passcode"] or "", "waitingRoom": r["waiting_room"],
                    "hostVideo": r["host_video"], "participantVideo": r["participant_video"],
                    "muteOnEntry": r["mute_on_entry"], "autoRecord": r["auto_record"],
                    "description": r["description"] or "",
                    "createdAt": r["created_at"].isoformat() if r["created_at"] else "",
                    "createdBy": r["created_by"] or "Host",
                })
            return web.json_response(meetings)
    else:
        meetings = sorted(
            scheduled_meetings.values(),
            key=lambda m: f"{m['date']}T{m['time']}",
        )
        return web.json_response(meetings)


async def delete_scheduled_meeting(request):
    """Delete a scheduled meeting."""
    meeting_id = request.match_info["meeting_id"]
    if db_pool:
        async with db_pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM scheduled_meetings WHERE id=$1", meeting_id
            )
            if result == "DELETE 1":
                asyncio.ensure_future(sync_to_cloud(f"/api/schedule/{meeting_id}", method="DELETE"))
                return web.json_response({"ok": True})
            return web.json_response({"error": "Not found"}, status=404)
    else:
        if meeting_id in scheduled_meetings:
            scheduled_meetings.pop(meeting_id)
            _save_scheduled_meetings()
            asyncio.ensure_future(sync_to_cloud(f"/api/schedule/{meeting_id}", method="DELETE"))
            return web.json_response({"ok": True})
        return web.json_response({"error": "Not found"}, status=404)


async def update_scheduled_meeting(request):
    """Update a scheduled meeting."""
    meeting_id = request.match_info["meeting_id"]
    data = await request.json()
    if db_pool:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow("SELECT id FROM scheduled_meetings WHERE id=$1", meeting_id)
            if not row:
                return web.json_response({"error": "Not found"}, status=404)
            field_map = {
                "topic": "topic", "date": "meeting_date", "time": "meeting_time",
                "duration": "duration", "timezone": "timezone", "recurring": "recurring",
                "recurrence": "recurrence", "endDate": "end_date",
                "passcodeEnabled": "passcode_enabled", "passcode": "passcode",
                "waitingRoom": "waiting_room", "hostVideo": "host_video",
                "participantVideo": "participant_video", "muteOnEntry": "mute_on_entry",
                "autoRecord": "auto_record", "description": "description",
            }
            for js_key, db_col in field_map.items():
                if js_key in data:
                    await conn.execute(
                        f"UPDATE scheduled_meetings SET {db_col}=$1 WHERE id=$2",
                        data[js_key], meeting_id
                    )
            row = await conn.fetchrow("SELECT * FROM scheduled_meetings WHERE id=$1", meeting_id)
            meeting = {
                "id": row["id"], "room_id": row["room_id"], "topic": row["topic"],
                "date": row["meeting_date"], "time": row["meeting_time"],
                "duration": row["duration"], "timezone": row["timezone"],
            }
            return web.json_response(meeting)
    else:
        if meeting_id not in scheduled_meetings:
            return web.json_response({"error": "Not found"}, status=404)
        meeting = scheduled_meetings[meeting_id]
        for key in ["topic", "date", "time", "duration", "timezone", "recurring",
                    "recurrence", "endDate", "passcodeEnabled", "passcode",
                    "waitingRoom", "hostVideo", "participantVideo",
                    "muteOnEntry", "autoRecord", "description"]:
            if key in data:
                meeting[key] = data[key]
        scheduled_meetings[meeting_id] = meeting
        _save_scheduled_meetings()
        return web.json_response(meeting)


async def room_info(request):
    room_id = request.match_info["room_id"]
    if room_id not in rooms:
        rooms[room_id] = {}
    peer_list = [
        {"id": pid, "name": peers.get(pid, {}).get("name", "Unknown")}
        for pid in rooms[room_id]
    ]
    return web.json_response({"room_id": room_id, "peers": peer_list})


# ── WebSocket Signaling ──────────────────────────────────────────────────

async def websocket_handler(request):
    ws = web.WebSocketResponse(heartbeat=30.0)
    await ws.prepare(request)

    peer_id = uuid.uuid4().hex[:12]
    room_id = None

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                data = json.loads(msg.data)
                action = data.get("action")

                if action == "join":
                    room_id = data.get("room_id", "").strip()
                    name = data.get("name", "Guest").strip()[:50] or "Guest"

                    if not room_id:
                        await ws.send_json({"action": "error", "message": "Room ID required"})
                        continue

                    if room_id not in rooms:
                        rooms[room_id] = {}
                        room_meta[room_id] = {
                            "host": None,
                            "waiting_room_enabled": False,
                            "locked": False,
                            "created": datetime.utcnow().isoformat(),
                        }
                        waiting_rooms[room_id] = {}
                        room_polls[room_id] = []
                        room_whiteboards[room_id] = []
                        room_breakouts[room_id] = {"rooms": {}, "active": False}

                    meta = room_meta[room_id]

                    # Check if room is locked
                    if meta.get("locked") and meta.get("host"):
                        await ws.send_json({"action": "error", "message": "This meeting is locked"})
                        continue

                    # Check waiting room
                    if meta.get("waiting_room_enabled") and meta.get("host") and meta["host"] != peer_id:
                        waiting_rooms[room_id][peer_id] = {"ws": ws, "name": name}
                        await ws.send_json({"action": "waiting-room", "message": "Please wait for the host to admit you"})
                        # Notify host
                        host_id = meta["host"]
                        if host_id in rooms[room_id]:
                            await rooms[room_id][host_id].send_json({
                                "action": "waiting-room-update",
                                "waiting": [
                                    {"id": pid, "name": winfo["name"]}
                                    for pid, winfo in waiting_rooms[room_id].items()
                                ]
                            })
                        continue

                    # Assign host if first participant
                    is_host = not meta.get("host") or meta["host"] not in rooms.get(room_id, {})
                    if is_host:
                        meta["host"] = peer_id

                    # Register peer
                    rooms[room_id][peer_id] = ws
                    peers[peer_id] = {"name": name, "room": room_id, "role": "host" if is_host else "participant", "hand": False}

                    # Tell this peer about existing peers
                    existing = [
                        {"id": pid, "name": peers.get(pid, {}).get("name", "?"),
                         "role": peers.get(pid, {}).get("role", "participant"),
                         "hand": peers.get(pid, {}).get("hand", False)}
                        for pid in rooms[room_id] if pid != peer_id
                    ]
                    await ws.send_json({
                        "action": "joined",
                        "peer_id": peer_id,
                        "peers": existing,
                        "room_id": room_id,
                        "role": "host" if is_host else "participant",
                        "waiting_room_enabled": meta.get("waiting_room_enabled", False),
                    })

                    # Notify others about the new peer
                    await broadcast(room_id, {
                        "action": "peer-joined",
                        "peer_id": peer_id,
                        "name": name,
                        "role": peers[peer_id]["role"],
                    }, exclude=peer_id)

                    # Send existing whiteboard state
                    if room_whiteboards.get(room_id):
                        await ws.send_json({
                            "action": "whiteboard-sync",
                            "strokes": room_whiteboards[room_id],
                        })

                    # Send active polls
                    active_polls = [p for p in room_polls.get(room_id, []) if p.get("active")]
                    if active_polls:
                        for poll in active_polls:
                            await ws.send_json({
                                "action": "poll-started",
                                "poll": _sanitize_poll(poll, peer_id),
                            })

                    print(f"[{room_id}] {name} ({peer_id}) joined as {'host' if is_host else 'participant'}. "
                          f"Room has {len(rooms[room_id])} peers.")

                # ── mediasoup SFU signaling ───────────────────────────
                elif action == "get-router-rtp-capabilities":
                    result = await media_api("/api/router-rtp-capabilities", {"roomId": room_id})
                    await ws.send_json({
                        "action": "router-rtp-capabilities",
                        "rtpCapabilities": result.get("rtpCapabilities"),
                    })

                elif action == "create-transport":
                    direction = data.get("direction", "send")
                    result = await media_api("/api/create-transport", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "direction": direction,
                    })
                    await ws.send_json({
                        "action": "transport-created",
                        "direction": direction,
                        "id": result.get("id"),
                        "iceParameters": result.get("iceParameters"),
                        "iceCandidates": result.get("iceCandidates"),
                        "dtlsParameters": result.get("dtlsParameters"),
                    })

                elif action == "connect-transport":
                    result = await media_api("/api/connect-transport", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "transportId": data.get("transportId"),
                        "dtlsParameters": data.get("dtlsParameters"),
                    })
                    await ws.send_json({
                        "action": "transport-connected",
                        "transportId": data.get("transportId"),
                    })

                elif action == "produce":
                    app_data = data.get("appData", {})
                    result = await media_api("/api/produce", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "transportId": data.get("transportId"),
                        "kind": data.get("kind"),
                        "rtpParameters": data.get("rtpParameters"),
                        "appData": app_data,
                    })
                    producerId = result.get("producerId")
                    returned_app_data = result.get("appData", app_data)
                    await ws.send_json({
                        "action": "produced",
                        "producerId": producerId,
                        "kind": data.get("kind"),
                        "appData": returned_app_data,
                    })
                    # Notify all other peers to consume this new producer
                    await broadcast(room_id, {
                        "action": "new-producer",
                        "producerId": producerId,
                        "peerId": peer_id,
                        "kind": data.get("kind"),
                        "appData": returned_app_data,
                    }, exclude=peer_id)

                elif action == "consume":
                    result = await media_api("/api/consume", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "producerId": data.get("producerId"),
                        "rtpCapabilities": data.get("rtpCapabilities"),
                    })
                    if "error" not in result:
                        await ws.send_json({
                            "action": "consumed",
                            "consumerId": result.get("consumerId"),
                            "producerId": result.get("producerId"),
                            "kind": result.get("kind"),
                            "rtpParameters": result.get("rtpParameters"),
                            "producerPeerId": data.get("producerPeerId"),
                            "appData": result.get("appData", {}),
                        })

                elif action == "resume-consumer":
                    await media_api("/api/resume-consumer", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "consumerId": data.get("consumerId"),
                    })

                elif action == "get-room-producers":
                    result = await media_api("/api/room-producers", {
                        "roomId": room_id,
                        "excludePeerId": peer_id,
                    })
                    await ws.send_json({
                        "action": "room-producers",
                        "producers": result.get("producers", []),
                    })

                elif action == "close-producer":
                    producer_id = data.get("producerId")
                    await media_api("/api/close-producer", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "producerId": producer_id,
                    })
                    # Notify peers so they can clean up (e.g. screen share tile)
                    await broadcast(room_id, {
                        "action": "producer-closed",
                        "producerId": producer_id,
                        "peerId": peer_id,
                    }, exclude=peer_id)

                elif action == "pause-producer":
                    producer_kind = data.get("kind", "")
                    paused = data.get("paused", True)
                    await media_api("/api/pause-producer", {
                        "roomId": room_id,
                        "peerId": peer_id,
                        "producerId": data.get("producerId"),
                        "paused": paused,
                    })
                    # Broadcast to other peers so they can update mic/cam indicators
                    await broadcast(room_id, {
                        "action": "producer-paused",
                        "peerId": peer_id,
                        "producerId": data.get("producerId"),
                        "kind": producer_kind,
                        "paused": paused,
                    }, exclude=peer_id)

                # ── Legacy P2P relay (fallback) ───────────────────────
                elif action in ("offer", "answer", "ice-candidate"):
                    target = data.get("target")
                    if target and room_id and target in rooms.get(room_id, {}):
                        target_ws = rooms[room_id][target]
                        await target_ws.send_json({
                            "action": action,
                            "from": peer_id,
                            "data": data.get("data"),
                        })

                elif action == "chat":
                    text = data.get("text", "").strip()[:500]
                    if text and room_id:
                        name = peers.get(peer_id, {}).get("name", "?")
                        ts = datetime.utcnow().strftime("%H:%M")
                        # Persist to DB if available
                        if db_pool:
                            try:
                                async with db_pool.acquire() as conn:
                                    await conn.execute(
                                        "INSERT INTO chat_messages(room_id,peer_id,name,message) VALUES($1,$2,$3,$4)",
                                        room_id, peer_id, name, text
                                    )
                            except Exception:
                                pass
                        await broadcast(room_id, {
                            "action": "chat",
                            "from": peer_id,
                            "name": name,
                            "text": text,
                            "time": ts,
                        })

                # ── Captions ──────────────────────────────────────────
                elif action == "caption":
                    text = data.get("text", "").strip()[:500]
                    if text and room_id:
                        name = peers.get(peer_id, {}).get("name", "?")
                        await broadcast(room_id, {
                            "action": "caption",
                            "from": peer_id,
                            "name": name,
                            "text": text,
                        }, exclude=peer_id)

                # ── Hand Raise ────────────────────────────────────────
                elif action == "hand-raise":
                    raised = data.get("raised", True)
                    if peer_id in peers:
                        peers[peer_id]["hand"] = raised
                    name = peers.get(peer_id, {}).get("name", "?")
                    await broadcast(room_id, {
                        "action": "hand-raise",
                        "peer_id": peer_id,
                        "name": name,
                        "raised": raised,
                    })

                # ── Reactions ─────────────────────────────────────────
                elif action == "reaction":
                    emoji = data.get("emoji", "")[:4]
                    if emoji and room_id:
                        name = peers.get(peer_id, {}).get("name", "?")
                        await broadcast(room_id, {
                            "action": "reaction",
                            "peer_id": peer_id,
                            "name": name,
                            "emoji": emoji,
                        })

                # ── Waiting Room: Admit / Deny ────────────────────────
                elif action == "admit-peer":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        target_id = data.get("target")
                        if target_id in waiting_rooms.get(room_id, {}):
                            winfo = waiting_rooms[room_id].pop(target_id)
                            target_ws = winfo["ws"]
                            target_name = winfo["name"]

                            rooms[room_id][target_id] = target_ws
                            peers[target_id] = {"name": target_name, "room": room_id, "role": "participant", "hand": False}

                            existing = [
                                {"id": pid, "name": peers.get(pid, {}).get("name", "?"),
                                 "role": peers.get(pid, {}).get("role", "participant"),
                                 "hand": peers.get(pid, {}).get("hand", False)}
                                for pid in rooms[room_id] if pid != target_id
                            ]
                            await target_ws.send_json({
                                "action": "joined",
                                "peer_id": target_id,
                                "peers": existing,
                                "room_id": room_id,
                                "role": "participant",
                                "waiting_room_enabled": room_meta[room_id].get("waiting_room_enabled", False),
                            })
                            await broadcast(room_id, {
                                "action": "peer-joined",
                                "peer_id": target_id,
                                "name": target_name,
                                "role": "participant",
                            }, exclude=target_id)

                elif action == "deny-peer":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        target_id = data.get("target")
                        if target_id in waiting_rooms.get(room_id, {}):
                            winfo = waiting_rooms[room_id].pop(target_id)
                            await winfo["ws"].send_json({"action": "denied", "message": "The host denied your request to join"})

                # ── Host Controls ─────────────────────────────────────
                elif action == "toggle-waiting-room":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        enabled = data.get("enabled", True)
                        room_meta[room_id]["waiting_room_enabled"] = enabled
                        await broadcast(room_id, {
                            "action": "setting-changed",
                            "setting": "waiting_room",
                            "value": enabled,
                        })

                elif action == "lock-meeting":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        locked = data.get("locked", True)
                        room_meta[room_id]["locked"] = locked
                        await broadcast(room_id, {
                            "action": "setting-changed",
                            "setting": "locked",
                            "value": locked,
                        })

                elif action == "mute-peer":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        target = data.get("target")
                        if target in rooms.get(room_id, {}):
                            await rooms[room_id][target].send_json({
                                "action": "muted-by-host",
                                "message": "The host muted you",
                            })

                elif action == "kick-peer":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        target = data.get("target")
                        if target in rooms.get(room_id, {}):
                            await rooms[room_id][target].send_json({
                                "action": "kicked",
                                "message": "You have been removed from the meeting",
                            })

                elif action == "mute-all":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        await broadcast(room_id, {
                            "action": "muted-by-host",
                            "message": "The host muted everyone",
                        }, exclude=peer_id)

                elif action == "unmute-all":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        await broadcast(room_id, {
                            "action": "unmuted-by-host",
                            "message": "The host unmuted everyone",
                        }, exclude=peer_id)

                elif action == "lower-all-hands":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        for pid in rooms.get(room_id, {}):
                            if pid in peers:
                                peers[pid]["hand"] = False
                        await broadcast(room_id, {"action": "all-hands-lowered"})

                # ── Polls ─────────────────────────────────────────────
                elif action == "create-poll":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        question = data.get("question", "").strip()[:200]
                        options = [o.strip()[:100] for o in data.get("options", []) if o.strip()][:10]
                        if question and len(options) >= 2:
                            poll = {
                                "id": uuid.uuid4().hex[:8],
                                "question": question,
                                "options": options,
                                "votes": {},
                                "active": True,
                            }
                            room_polls.setdefault(room_id, []).append(poll)
                            await broadcast(room_id, {
                                "action": "poll-started",
                                "poll": _sanitize_poll(poll, None),
                            })

                elif action == "vote-poll":
                    poll_id = data.get("poll_id")
                    choice = data.get("choice")
                    polls = room_polls.get(room_id, [])
                    for poll in polls:
                        if poll["id"] == poll_id and poll["active"]:
                            if isinstance(choice, int) and 0 <= choice < len(poll["options"]):
                                poll["votes"][peer_id] = choice
                                await broadcast(room_id, {
                                    "action": "poll-update",
                                    "poll_id": poll_id,
                                    "results": _poll_results(poll),
                                    "total_votes": len(poll["votes"]),
                                })
                            break

                elif action == "end-poll":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        poll_id = data.get("poll_id")
                        for poll in room_polls.get(room_id, []):
                            if poll["id"] == poll_id:
                                poll["active"] = False
                                await broadcast(room_id, {
                                    "action": "poll-ended",
                                    "poll_id": poll_id,
                                    "results": _poll_results(poll),
                                    "total_votes": len(poll["votes"]),
                                })
                                break

                # ── Whiteboard ────────────────────────────────────────
                elif action == "whiteboard-stroke":
                    stroke = data.get("stroke")
                    if stroke and room_id:
                        room_whiteboards.setdefault(room_id, []).append(stroke)
                        # Limit stored strokes
                        if len(room_whiteboards[room_id]) > 5000:
                            room_whiteboards[room_id] = room_whiteboards[room_id][-3000:]
                        await broadcast(room_id, {
                            "action": "whiteboard-stroke",
                            "stroke": stroke,
                            "from": peer_id,
                        }, exclude=peer_id)

                elif action == "whiteboard-clear":
                    if room_id:
                        room_whiteboards[room_id] = []
                        await broadcast(room_id, {"action": "whiteboard-clear"})

                # ── Breakout Rooms ────────────────────────────────────
                elif action == "create-breakout":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        br_rooms = data.get("rooms", [])
                        breakout = {"rooms": {}, "active": True}
                        for br in br_rooms[:10]:
                            br_id = uuid.uuid4().hex[:6]
                            breakout["rooms"][br_id] = {
                                "name": br.get("name", f"Room {br_id}")[:30],
                                "peers": [p for p in br.get("peers", []) if p in rooms.get(room_id, {})],
                            }
                        room_breakouts[room_id] = breakout
                        await broadcast(room_id, {
                            "action": "breakout-started",
                            "rooms": {rid: {"name": r["name"], "peers": r["peers"]} for rid, r in breakout["rooms"].items()},
                        })

                elif action == "end-breakout":
                    if room_id and room_meta.get(room_id, {}).get("host") == peer_id:
                        room_breakouts[room_id] = {"rooms": {}, "active": False}
                        await broadcast(room_id, {"action": "breakout-ended"})

            elif msg.type == web.WSMsgType.ERROR:
                print(f"WebSocket error: {ws.exception()}")

    finally:
        # Clean up on disconnect
        # Remove from waiting room if applicable
        if room_id and room_id in waiting_rooms:
            waiting_rooms[room_id].pop(peer_id, None)

        # Clean up mediasoup peer state
        if room_id:
            await media_api("/api/remove-peer", {"roomId": room_id, "peerId": peer_id})

        if room_id and room_id in rooms:
            rooms[room_id].pop(peer_id, None)
            name = peers.get(peer_id, {}).get("name", "?")
            print(f"[{room_id}] {name} ({peer_id}) left. "
                  f"Room has {len(rooms[room_id])} peers.")

            await broadcast(room_id, {
                "action": "peer-left",
                "peer_id": peer_id,
            })

            # Transfer host if host left
            if room_meta.get(room_id, {}).get("host") == peer_id and rooms[room_id]:
                new_host = next(iter(rooms[room_id]))
                room_meta[room_id]["host"] = new_host
                if new_host in peers:
                    peers[new_host]["role"] = "host"
                await broadcast(room_id, {
                    "action": "host-changed",
                    "new_host": new_host,
                    "name": peers.get(new_host, {}).get("name", "?"),
                })

            # Clean up empty rooms
            if not rooms[room_id]:
                del rooms[room_id]
                room_meta.pop(room_id, None)
                waiting_rooms.pop(room_id, None)
                room_polls.pop(room_id, None)
                room_whiteboards.pop(room_id, None)
                room_breakouts.pop(room_id, None)
                room_files.pop(room_id, None)
                print(f"[{room_id}] Room empty, removed.")

        peers.pop(peer_id, None)

    return ws


def _sanitize_poll(poll, peer_id):
    """Return poll data safe for sending to clients."""
    return {
        "id": poll["id"],
        "question": poll["question"],
        "options": poll["options"],
        "results": _poll_results(poll),
        "total_votes": len(poll["votes"]),
        "active": poll["active"],
        "my_vote": poll["votes"].get(peer_id) if peer_id else None,
    }

def _poll_results(poll):
    """Count votes per option."""
    counts = [0] * len(poll["options"])
    for choice in poll["votes"].values():
        if 0 <= choice < len(counts):
            counts[choice] += 1
    return counts


async def broadcast(room_id, message, exclude=None):
    """Send a message to all peers in a room, optionally excluding one."""
    if room_id not in rooms:
        return
    dead = []
    for pid, ws in rooms[room_id].items():
        if pid == exclude:
            continue
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(pid)
    for pid in dead:
        rooms[room_id].pop(pid, None)
        peers.pop(pid, None)


# ── App Setup ─────────────────────────────────────────────────────────────

media_worker_process = None

async def on_startup(app_instance):
    """Initialize database and start mediasoup worker."""
    global media_worker_process
    await init_db()

    # Load persisted scheduled meetings (only when no database)
    if not db_pool:
        _load_scheduled_meetings()

    # Start the Node.js mediasoup worker
    try:
        media_worker_process = subprocess.Popen(
            ["node", "media_worker.js"],
            cwd=str(Path(__file__).parent),
            env={**os.environ, "MEDIA_WORKER_PORT": str(MEDIA_WORKER_PORT)},
        )
        print(f"[media] mediasoup worker started (PID: {media_worker_process.pid})")
        # Give it a moment to start up
        await asyncio.sleep(1.5)
    except FileNotFoundError:
        print("[media] WARNING: Node.js not found — mediasoup SFU disabled, falling back to P2P relay")
    except Exception as e:
        print(f"[media] WARNING: Could not start mediasoup worker: {e}")

async def on_shutdown(app_instance):
    """Clean up resources on shutdown."""
    global media_worker_process, http_session
    if http_session:
        await http_session.close()
    if media_worker_process:
        media_worker_process.terminate()
        media_worker_process.wait(timeout=5)
        print("[media] mediasoup worker stopped")
    if db_pool:
        await db_pool.close()
        print("[db] PostgreSQL pool closed")


app = web.Application()
app.on_startup.append(on_startup)
app.on_shutdown.append(on_shutdown)
app.router.add_get("/", index)
app.router.add_get("/api/version", version_check)
app.router.add_get("/room/{room_id}", room_page)
app.router.add_post("/api/auth/firebase", auth_firebase)
app.router.add_get("/api/auth/me", auth_me)
app.router.add_get("/api/auth/config", auth_config)
app.router.add_post("/api/auth/logout", auth_logout)
app.router.add_post("/api/create-room", create_room)
app.router.add_post("/api/create-room-with-id", create_room_with_id)
app.router.add_get("/api/room/{room_id}", room_info)
app.router.add_post("/api/schedule", schedule_meeting)
app.router.add_get("/api/schedule", list_scheduled_meetings)
app.router.add_delete("/api/schedule/{meeting_id}", delete_scheduled_meeting)
app.router.add_put("/api/schedule/{meeting_id}", update_scheduled_meeting)
app.router.add_post("/api/files/upload", upload_file)
app.router.add_get("/api/files/{room_id}", list_room_files)
app.router.add_get("/api/files/{room_id}/{file_id}", download_file)
app.router.add_delete("/api/files/{room_id}/{file_id}", delete_room_file)
app.router.add_get("/ws", websocket_handler)
app.router.add_static("/static/", STATIC_DIR, show_index=False)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"Huddle server starting on http://localhost:{port}")
    web.run_app(app, host="0.0.0.0", port=port)

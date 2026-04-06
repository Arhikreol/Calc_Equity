from __future__ import annotations

import json
import os
import re
import time
import uuid
from datetime import date, datetime
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

COOKIE_NAME = "equity_viewer_vid"
COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400
DAILY_HISTORY_DAYS = 120
LOCK_TIMEOUT_SECONDS = 10.0
HOST = "0.0.0.0"
PORT = 8123
VISITOR_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")

DATA_DIR = Path(r"C:\ProgramData\Calc_Equity\visit-counter")
STATE_PATH = DATA_DIR / "visit_counter.json"
LOCK_PATH = DATA_DIR / "visit_counter.lock"


class VisitCounterHandler(BaseHTTPRequestHandler):
    server_version = "CalcEquityVisitCounter/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/visit-counter":
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return

        try:
            payload, set_cookie = update_counter(self.headers.get("Cookie", ""))
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "overallUniqueVisitors": payload["overall_unique_visitors"],
                    "todayUniqueVisitors": payload["today_unique_visitors"],
                    "overallVisits": payload["overall_visits"],
                    "todayVisits": payload["today_visits"],
                    "today": payload["today"],
                },
                set_cookie=set_cookie,
            )
        except Exception as exc:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "ok": False,
                    "error": str(exc),
                },
            )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_json(
        self,
        status: HTTPStatus,
        payload: dict[str, object],
        *,
        set_cookie: str | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if not origin:
            return

        host_header = self.headers.get("Host", "")
        if not is_allowed_origin(origin, host_header):
            return

        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Vary", "Origin")

    def log_message(self, format: str, *args: object) -> None:
        return


def is_allowed_origin(origin: str, host_header: str) -> bool:
    try:
        origin_parts = urlparse(origin)
    except ValueError:
        return False

    if not origin_parts.scheme.startswith("http"):
        return False

    request_host = host_header.split(":", 1)[0].strip().lower()
    origin_host = (origin_parts.hostname or "").strip().lower()
    return bool(request_host and origin_host and request_host == origin_host)


def update_counter(cookie_header: str) -> tuple[dict[str, object], str | None]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now().astimezone()
    today_key = now.date().isoformat()

    visitor_id = get_cookie_visitor_id(cookie_header)
    should_set_cookie = visitor_id is None
    if visitor_id is None:
        visitor_id = uuid.uuid4().hex

    lock_fd = acquire_lock(LOCK_PATH, LOCK_TIMEOUT_SECONDS)
    try:
        state = load_state(STATE_PATH)
        prune_state(state, now.date())
        payload = update_state(state, visitor_id, now, today_key)
        save_state(STATE_PATH, state)
    finally:
        release_lock(lock_fd, LOCK_PATH)

    return payload, build_cookie_header(visitor_id) if should_set_cookie else None


def get_cookie_visitor_id(cookie_header: str) -> str | None:
    if not cookie_header:
        return None

    cookie = SimpleCookie()
    cookie.load(cookie_header)
    morsel = cookie.get(COOKIE_NAME)
    if morsel is None:
        return None

    value = morsel.value.strip().lower()
    if not VISITOR_ID_PATTERN.fullmatch(value):
        return None
    return value


def build_cookie_header(visitor_id: str) -> str:
    cookie = SimpleCookie()
    cookie[COOKIE_NAME] = visitor_id
    cookie[COOKIE_NAME]["path"] = "/"
    cookie[COOKIE_NAME]["max-age"] = str(COOKIE_MAX_AGE_SECONDS)
    cookie[COOKIE_NAME]["httponly"] = True
    cookie[COOKIE_NAME]["samesite"] = "Lax"
    return cookie.output(header="").strip()


def acquire_lock(lock_path: Path, timeout_seconds: float) -> int:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode("ascii"))
            return fd
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Visit counter lock timeout")
            time.sleep(0.05)


def release_lock(fd: int, lock_path: Path) -> None:
    try:
        os.close(fd)
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def load_state(state_path: Path) -> dict[str, object]:
    if not state_path.exists():
        return default_state()

    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return default_state()


def save_state(state_path: Path, state: dict[str, object]) -> None:
    temp_path = state_path.with_suffix(".tmp")
    temp_path.write_text(
        json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    os.replace(temp_path, state_path)


def default_state() -> dict[str, object]:
    return {
        "overall_unique": 0,
        "total_hits": 0,
        "known_visitors": {},
        "daily_unique": {},
        "daily_hits": {},
        "updated_at": None,
    }


def prune_state(state: dict[str, object], today: date) -> None:
    daily_unique = state.setdefault("daily_unique", {})
    daily_hits = state.setdefault("daily_hits", {})

    for key in list(daily_unique.keys()):
        if is_stale_date(key, today):
            daily_unique.pop(key, None)

    for key in list(daily_hits.keys()):
        if is_stale_date(key, today):
            daily_hits.pop(key, None)


def is_stale_date(value: str, today: date) -> bool:
    try:
        record_date = date.fromisoformat(value)
    except ValueError:
        return True
    age_days = (today - record_date).days
    return age_days > DAILY_HISTORY_DAYS or age_days < -1


def update_state(
    state: dict[str, object],
    visitor_id: str,
    now: datetime,
    today_key: str,
) -> dict[str, object]:
    state["total_hits"] = int(state.get("total_hits", 0)) + 1
    known_visitors = state.setdefault("known_visitors", {})
    daily_unique = state.setdefault("daily_unique", {})
    daily_hits = state.setdefault("daily_hits", {})

    if visitor_id not in known_visitors:
        known_visitors[visitor_id] = now.isoformat()
        state["overall_unique"] = int(state.get("overall_unique", 0)) + 1

    today_visitors = daily_unique.setdefault(today_key, {})
    if visitor_id not in today_visitors:
        today_visitors[visitor_id] = now.isoformat()

    daily_hits[today_key] = int(daily_hits.get(today_key, 0)) + 1
    state["updated_at"] = now.isoformat()

    return {
        "overall_unique_visitors": int(state.get("overall_unique", 0)),
        "today_unique_visitors": len(today_visitors),
        "overall_visits": int(state.get("total_hits", 0)),
        "today_visits": int(daily_hits.get(today_key, 0)),
        "today": today_key,
    }


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), VisitCounterHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()

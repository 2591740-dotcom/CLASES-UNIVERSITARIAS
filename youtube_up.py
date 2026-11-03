"""Sube el video de una clase a un canal de YouTube y devuelve el enlace."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import engine

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "data" / "youtube.json"
CHUNK = 8 * 1024 * 1024
UPLOAD_SCOPE = (
    "https://www.googleapis.com/auth/youtube.upload "
    "https://www.googleapis.com/auth/youtube.readonly "
    "https://www.googleapis.com/auth/youtube.force-ssl"
)
_ACCESS = {"token": "", "until": 0.0}


def _load() -> dict:
    if not CONFIG.is_file():
        return {}
    try:
        raw = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _save(data: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    stored = {
        "client_id": str(data.get("client_id") or ""),
        "client_secret": str(data.get("client_secret") or ""),
        "refresh_token": str(data.get("refresh_token") or ""),
        "channel": str(data.get("channel") or ""),
    }
    CONFIG.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def configured() -> bool:
    data = _load()
    return bool(data.get("client_id") and data.get("client_secret") and data.get("refresh_token"))


def public_status() -> dict:
    data = _load()
    return {
        "connected": configured(),
        "channel": str(data.get("channel") or ""),
    }


def video_body(title: str) -> dict:
    name = " ".join(str(title or "").split())[:100] or "Clase"
    return {
        "snippet": {
            "title": name,
            "description": "ClaseClara",
            "categoryId": "27",
        },
        "status": {
            "privacyStatus": "unlisted",
            "embeddable": True,
            "selfDeclaredMadeForKids": False,
        },
    }


def content_range(start: int, end: int, total: int) -> str:
    return f"bytes {start}-{end}/{total}"


def _post_form(url: str, fields: dict) -> dict:
    payload = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:240]
        raise engine.AppError(f"Google no aceptó la cuenta de YouTube. {detail}") from exc
    except urllib.error.URLError as exc:
        raise engine.AppError("No pude llegar a Google.") from exc
    if not isinstance(raw, dict):
        raise engine.AppError("Google respondió algo que no entiendo.")
    return raw


def _access_token() -> str:
    now = time.time()
    if _ACCESS["token"] and _ACCESS["until"] > now + 30:
        return str(_ACCESS["token"])
    data = _load()
    if not configured():
        raise engine.AppError("Falta conectar el canal de YouTube.")
    raw = _post_form(
        "https://oauth2.googleapis.com/token",
        {
            "client_id": data.get("client_id") or "",
            "client_secret": data.get("client_secret") or "",
            "refresh_token": data.get("refresh_token") or "",
            "grant_type": "refresh_token",
        },
    )
    token = str(raw.get("access_token") or "")
    if not token:
        raise engine.AppError("Google no entregó permiso para subir al canal.")
    _ACCESS["token"] = token
    _ACCESS["until"] = now + int(raw.get("expires_in") or 3500)
    return token


def _id_video(value: str) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", text):
        return text
    return ""


def borrar_video(video_id: str) -> str:
    """Borra un video del canal. «permiso» significa que la cuenta aún no puede borrarlos."""
    video_id = _id_video(video_id)
    if not video_id or not configured():
        return "nada"
    try:
        token = _access_token()
    except engine.AppError:
        return "nada"
    pedido = urllib.request.Request(
        "https://www.googleapis.com/youtube/v3/videos?id=" + urllib.parse.quote(video_id),
        method="DELETE",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(pedido, timeout=30) as response:
            if response.status in {200, 204}:
                return "borrado"
    except urllib.error.HTTPError as exc:
        exc.read()
        if exc.code in {200, 204, 404}:
            return "borrado"
        if exc.code == 403:
            return "permiso"
        return "falla"
    except urllib.error.URLError:
        return "falla"
    return "falla"


def _channel_name(token: str) -> str:
    request = urllib.request.Request(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError):
        return ""
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list) or not items:
        return ""
    snippet = items[0].get("snippet") if isinstance(items[0], dict) else {}
    if not isinstance(snippet, dict):
        return ""
    return str(snippet.get("title") or "")[:120]


def connect(client_id: str, client_secret: str) -> dict:
    client_id = str(client_id or "").strip()
    client_secret = str(client_secret or "").strip()
    if not client_id or not client_secret:
        raise engine.AppError("Pon el ID de cliente y el secreto de YouTube.")
    current = _load()
    current["client_id"] = client_id
    current["client_secret"] = client_secret
    _save(current)
    port = 8737
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), _OAuthHandler)
    except OSError as exc:
        raise engine.AppError("No pude abrir la ventana para autorizar YouTube.") from exc
    redirect = f"http://127.0.0.1:{port}/"
    query = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": UPLOAD_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    })
    box: dict[str, str] = {}
    server.box = box  # type: ignore[attr-defined]
    server.timeout = 1
    webbrowser.open(f"https://accounts.google.com/o/oauth2/v2/auth?{query}")
    deadline = time.time() + 180
    try:
        while "code" not in box and "error" not in box and time.time() < deadline:
            server.handle_request()
    finally:
        server.server_close()
    if "code" not in box:
        raise engine.AppError("No se autorizó el canal de YouTube.")
    raw = _post_form(
        "https://oauth2.googleapis.com/token",
        {
            "code": box["code"],
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
        },
    )
    refresh = str(raw.get("refresh_token") or "")
    access = str(raw.get("access_token") or "")
    if not refresh or not access:
        raise engine.AppError("Google no entregó permiso permanente. Vuelve a conectar el canal.")
    channel = _channel_name(access)
    _ACCESS["token"] = access
    _ACCESS["until"] = time.time() + int(raw.get("expires_in") or 3500)
    guardado = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh,
        "channel": channel,
    }
    _save(guardado)
    try:
        import cloud
        cloud.guardar_privado("youtube.json", guardado)
    except engine.AppError as exc:
        raise engine.AppError("El canal quedó en esta PC, pero no pude dejarlo listo para la web.") from exc
    try:
        import cloud
        estado = cloud.leer_mes()
        if estado.get("videos"):
            estado["videoDia"] = ""
            cloud.guardar_mes(estado)
            cloud._soltar_videos(cloud.leer_mes(), cloud.dia_lima(time.time()))
    except Exception:
        pass
    return public_status()


class _OAuthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        box = getattr(self.server, "box", {})
        if query.get("code"):
            box["code"] = query["code"][0]
            page = "Listo. Vuelve a ClaseClara."
            status = 200
        else:
            box["error"] = (query.get("error") or ["cancelado"])[0]
            page = "No se autorizó YouTube."
            status = 400
        body = f"<p>{page}</p>".encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        return


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _request_json(request: urllib.request.Request, timeout: int) -> tuple[int, dict, str]:
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            payload = json.loads(raw) if raw else {}
            if not isinstance(payload, dict):
                payload = {}
            return response.status, payload, ""
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:240]
        header = exc.headers.get("Range") if exc.headers else ""
        return exc.code, {}, header or detail
    except urllib.error.URLError as exc:
        raise engine.AppError("Se cortó la subida a YouTube.") from exc
    except json.JSONDecodeError as exc:
        raise engine.AppError("YouTube respondió algo que no entiendo.") from exc


def upload(path: Path, title: str) -> str:
    if not path.is_file():
        raise engine.AppError("No encuentro el video para subirlo.")
    token = _access_token()
    size = path.stat().st_size
    if size < 1:
        raise engine.AppError("Ese video está vacío.")
    body = json.dumps(video_body(title)).encode("utf-8")
    opening = urllib.request.Request(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(size),
            "X-Upload-Content-Type": "video/*",
        },
    )
    try:
        with urllib.request.urlopen(opening, timeout=60) as response:
            location = response.headers.get("Location")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:240]
        raise engine.AppError(f"YouTube no abrió la subida. {detail}") from exc
    except urllib.error.URLError as exc:
        raise engine.AppError("No pude llegar a YouTube.") from exc
    if not location:
        raise engine.AppError("YouTube no abrió la subida.")
    start = 0
    with path.open("rb") as handle:
        while start < size:
            handle.seek(start)
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            end = start + len(chunk) - 1
            put = urllib.request.Request(
                location,
                data=chunk,
                method="PUT",
                headers={
                    "Content-Type": "video/*",
                    "Content-Length": str(len(chunk)),
                    "Content-Range": content_range(start, end, size),
                },
            )
            status, payload, hint = _request_json(put, 300)
            if status in {200, 201}:
                video_id = str(payload.get("id") or "")
                if not video_id:
                    raise engine.AppError("YouTube no devolvió el video.")
                return f"https://www.youtube.com/watch?v={video_id}"
            if status == 308:
                if hint.startswith("bytes="):
                    last = hint.split("-")[-1]
                    start = int(last) + 1 if last.isdigit() else end + 1
                else:
                    start = end + 1
                continue
            raise engine.AppError("YouTube no recibió el video.")
    raise engine.AppError("La subida a YouTube se cortó.")


def self_test() -> None:
    body = video_body("  Clase larga  ")
    assert body["status"]["privacyStatus"] == "unlisted"
    assert body["status"]["embeddable"] is True
    assert body["status"]["selfDeclaredMadeForKids"] is False
    assert body["snippet"]["title"] == "Clase larga"
    assert content_range(0, 7, 20) == "bytes 0-7/20"
    assert "youtube.upload" in UPLOAD_SCOPE
    assert "youtube.readonly" in UPLOAD_SCOPE
    assert "youtube.force-ssl" in UPLOAD_SCOPE
    assert _id_video("dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert _id_video("corto") == ""
    assert _id_video("tiene espacio") == ""
    assert public_status()["connected"] in {True, False}

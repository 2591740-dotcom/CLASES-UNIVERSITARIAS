"""Texto y diapositivas en Supabase. El video no se sube."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import engine

ROOT = Path(__file__).resolve().parent
CRED = ROOT / "data" / "supabase.json"
CLASSES = ROOT / "data" / "classes"
MAX_VIDEO = 2_500_000_000
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClaseClara"


def configured() -> bool:
    data = _cred()
    return bool(data.get("url") and data.get("service_role"))


def playback_url(url: str) -> str:
    cleaned = assert_zoom_url(url)
    parts = urllib.parse.urlsplit(cleaned)
    path = parts.path.replace("/rec/play/", "/rec/download/").replace("/rec/share/", "/rec/download/")
    return urllib.parse.urlunsplit(parts._replace(path=path))


def assert_zoom_url(url: str) -> str:
    text = " ".join(str(url or "").split())
    parts = urllib.parse.urlsplit(text)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host.endswith("zoom.us"):
        raise engine.AppError("Pega un enlace https de Zoom, el que empieza por zoom.us/rec/play/.")
    if not any(piece in parts.path for piece in ("/rec/play/", "/rec/share/", "/rec/download/")):
        raise engine.AppError("Ese enlace de Zoom no es la grabación. Usa el de reproducir, /rec/play/.")
    if len(text) > 2000:
        raise engine.AppError("Ese enlace es demasiado largo.")
    return text


def download(url: str, dest: Path) -> None:
    target = playback_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(target, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            kind = (response.headers.get("Content-Type") or "").lower()
            if "text/html" in kind:
                raise engine.AppError("Ese enlace no entregó el video. Tiene que abrir la grabación sin clave.")
            total = 0
            with dest.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_VIDEO:
                        raise engine.AppError("Ese video pasa de 2.5 GB.")
                    handle.write(chunk)
    except engine.AppError:
        dest.unlink(missing_ok=True)
        raise
    except (OSError, urllib.error.URLError) as exc:
        dest.unlink(missing_ok=True)
        raise engine.AppError("No pude bajar el video desde ese enlace.") from exc
    if not dest.is_file() or dest.stat().st_size < 100_000:
        dest.unlink(missing_ok=True)
        raise engine.AppError("El enlace no devolvió un video completo.")
    head = dest.read_bytes()[:80].lower()
    if head.startswith(b"<!doctype") or head.startswith(b"<html") or head.startswith(b"{"):
        dest.unlink(missing_ok=True)
        raise engine.AppError("Ese enlace no entregó el video. Tiene que abrir la grabación sin clave.")


def publish(class_id: str) -> None:
    if not configured() or not _valid_id(class_id):
        return
    folder = CLASSES / class_id
    meta_path = folder / "meta.json"
    if not meta_path.is_file():
        return
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    study = _read(folder / "study.json", {})
    transcript = _read(folder / "transcript.json", {})
    chat = _read(folder / "chat.json", [])
    lines = transcript.get("lines") if isinstance(transcript, dict) else []
    if not isinstance(lines, list):
        lines = []
    corpus = ""
    if isinstance(transcript, dict):
        corpus = transcript.get("text") or ""
    if not corpus:
        corpus = "\n".join(line.get("text") or "" for line in lines if isinstance(line, dict))
    if isinstance(study, dict) and study and engine.tree_has_broken(study):
        study = engine.repair_tree(study, corpus)
    if isinstance(study, dict) and study:
        study = engine.place_youtube(study, lines)
        study["links"] = engine.collect_links(study, lines)
    if not isinstance(study, dict):
        study = {}
    if not isinstance(chat, list):
        chat = []
    row = {
        "id": class_id,
        "titulo": (study.get("titulo") or meta.get("title") or "Clase")[:140],
        "materia": (meta.get("materia") or "")[:120],
        "video_url": meta.get("video_url") or "",
        "duracion": float(meta.get("duration") or 0),
        "estudio": study,
        "transcripcion": transcript if isinstance(transcript, dict) else {},
        "chat": chat,
        "estado": "lista" if meta.get("status") == "ready" else (meta.get("status") or "error"),
        "detalle": (meta.get("detail") or "")[:300],
    }
    if not row["video_url"]:
        remote = _request(
            "GET",
            f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=video_url",
        )
        if isinstance(remote, list) and remote:
            row["video_url"] = remote[0].get("video_url") or ""
    _request("POST", "/rest/v1/clases?on_conflict=id", row, prefer="resolution=merge-duplicates,return=minimal")
    slides = []
    for index, frame in enumerate(meta.get("frames") or [], start=1):
        if not isinstance(frame, dict):
            continue
        name = str(frame.get("file") or "")
        image = folder / "frames" / name
        if not image.is_file():
            continue
        stored = f"{class_id}/{name}"
        _upload_image(stored, image.read_bytes())
        slides.append({
            "clase_id": class_id,
            "orden": index,
            "tiempo": float(frame.get("time") or 0),
            "imagen_path": stored,
        })
    _request("DELETE", f"/rest/v1/diapositivas?clase_id=eq.{urllib.parse.quote(class_id)}")
    if slides:
        _request("POST", "/rest/v1/diapositivas", slides, prefer="return=minimal")


def publish_ready() -> int:
    if not configured() or not CLASSES.is_dir():
        return 0
    count = 0
    for folder in CLASSES.iterdir():
        meta_path = folder / "meta.json"
        study_path = folder / "study.json"
        if not meta_path.is_file() or not study_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if meta.get("status") == "ready":
            publish(folder.name)
            count += 1
    return count


def pending() -> list[dict]:
    if not configured():
        return []
    rows = _request(
        "GET",
        "/rest/v1/clases?estado=eq.pendiente&select=id,video_url,materia,titulo&video_url=not.is.null",
    )
    return rows if isinstance(rows, list) else []


def mark(class_id: str, estado: str, detalle: str) -> None:
    if not configured() or not _valid_id(class_id):
        return
    _request(
        "PATCH",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
        {"estado": estado[:40], "detalle": detalle[:300]},
        prefer="return=minimal",
    )


def remove(class_id: str) -> None:
    if not configured() or not _valid_id(class_id):
        return
    _request("DELETE", f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}", prefer="return=minimal")
    try:
        _request(
            "DELETE",
            "/storage/v1/object/diapositivas",
            {"prefixes": [class_id]},
            prefer="return=minimal",
        )
    except engine.AppError:
        return


def _valid_id(class_id: str) -> bool:
    import re
    return bool(re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{6}", class_id))


def _read(path: Path, fallback):
    if not path.is_file():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _cred() -> dict:
    if not CRED.is_file():
        return {}
    try:
        data = json.loads(CRED.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _upload_image(path: str, content: bytes) -> None:
    _request(
        "POST",
        "/storage/v1/object/diapositivas/" + urllib.parse.quote(path, safe="/"),
        content,
        content_type="image/jpeg",
        extra={"x-upsert": "true"},
    )


def _request(method: str, path: str, body=None, prefer: str = "", content_type: str = "", extra: dict | None = None):
    data = _cred()
    url = str(data.get("url") or "").rstrip("/")
    key = str(data.get("service_role") or "")
    if not url or not key:
        return None
    payload = None
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
    }
    if isinstance(body, (dict, list)):
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif isinstance(body, bytes):
        payload = body
        headers["Content-Type"] = content_type or "application/octet-stream"
    if prefer:
        headers["Prefer"] = prefer
    if extra:
        headers.update(extra)
    request = urllib.request.Request(url + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
            if not raw:
                return None
            try:
                return json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise engine.AppError(f"Supabase respondió {exc.code}. {detail}") from exc
    except urllib.error.URLError as exc:
        raise engine.AppError("No pude llegar a Supabase.") from exc


def self_test() -> None:
    sample = "https://ucv-edu-pe.zoom.us/rec/play/abc.def"
    play = playback_url(sample)
    assert "/rec/download/" in play and "/rec/play/" not in play
    share = playback_url("https://zoom.us/rec/share/token")
    assert share == "https://zoom.us/rec/share/token".replace("/rec/share/", "/rec/download/")
    try:
        assert_zoom_url("https://uvcv.edu.pe/mod/zoom/view.php?id=1")
    except engine.AppError:
        pass
    else:
        raise AssertionError("un enlace del campus no debe pasar")

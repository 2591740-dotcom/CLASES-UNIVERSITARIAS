"""ClaseClara: servidor local para estudiar un video de clase."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import traceback
import urllib.parse
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cloud
import engine
import youtube_up

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CLASSES = DATA / "classes"
SETTINGS = DATA / "settings.json"

META_LOCK = threading.Lock()
SETTINGS_LOCK = threading.Lock()
CHAT_LOCKS: dict[str, threading.Lock] = {}
CANCELLED: set[str] = set()
ACTIVE: set[str] = set()
YOUTUBE_UPLOADS: set[str] = set()
YOUTUBE_LOCK = threading.Lock()

VIDEO_EXT = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"}


class LimitedReader:
    def __init__(self, raw, limit: int):
        self.raw = raw
        self.left = limit

    def read(self, size: int = -1) -> bytes:
        if self.left <= 0:
            return b""
        if size < 0 or size > self.left:
            size = self.left
        chunk = self.raw.read(size)
        self.left -= len(chunk)
        return chunk


def find_marker(data: bytes, boundary: bytes) -> tuple[int, int]:
    crlf = data.find(b"\r\n--" + boundary)
    lf = data.find(b"\n--" + boundary)
    if crlf == -1 and lf == -1:
        return -1, 0
    if crlf == -1 or (lf != -1 and lf < crlf):
        return lf, 1
    return crlf, 2


def disposition_value(header: str, name: str) -> str:
    match = re.search(rf'{name}="([^"]*)"', header, re.I)
    if match:
        return match.group(1)
    match = re.search(rf"{name}=([^;]+)", header, re.I)
    return match.group(1).strip() if match else ""


def parse_multipart(reader: LimitedReader, boundary: str, dest: Path) -> tuple[dict[str, str], Path | None]:
    token = boundary.encode("ascii", "replace")
    opener = b"--" + token
    data = b""

    def fill(size: int = 65536) -> bytes:
        nonlocal data
        chunk = reader.read(size)
        data += chunk
        return chunk

    while opener not in data:
        if not fill():
            raise engine.AppError("La carga llegó vacía.")
        if len(data) > 1024 * 1024:
            raise engine.AppError("La carga no tiene un formato válido.")
    data = data[data.find(opener) + len(opener):]
    if data.startswith(b"--"):
        return {}, None
    while data[:2] not in (b"\r\n", b"\n") and not data.startswith(b"--"):
        if not fill(1024):
            break
    if data.startswith(b"\r\n"):
        data = data[2:]
    elif data.startswith(b"\n"):
        data = data[1:]

    fields: dict[str, str] = {}
    saved: Path | None = None
    while True:
        while b"\r\n\r\n" not in data and b"\n\n" not in data:
            if not fill():
                raise engine.AppError("La carga se cortó.")
        if b"\r\n\r\n" in data:
            head, data = data.split(b"\r\n\r\n", 1)
        else:
            head, data = data.split(b"\n\n", 1)
        header = head.decode("utf-8", "replace")
        disposition = ""
        for line in header.splitlines():
            if line.lower().startswith("content-disposition"):
                disposition = line.split(":", 1)[1]
        field_name = disposition_value(disposition, "name")
        filename = disposition_value(disposition, "filename")
        if filename:
            fields["_filename"] = filename
            suffix = Path(filename).suffix.lower()
            if suffix not in engine.ALLOWED_EXT:
                raise engine.AppError(
                    "Usa un video mp4, mkv, webm o el audio m4a de Zoom."
                )
            target = dest / f"original{suffix}"
            written = 0
            with target.open("wb") as handle:
                while True:
                    index, skip = find_marker(data, token)
                    if index != -1:
                        handle.write(data[:index])
                        data = data[index + skip:]
                        break
                    keep = len(token) + 4
                    if len(data) > keep:
                        piece = data[:-keep]
                        written += len(piece)
                        if written > 4 * 1024 ** 3:
                            raise engine.AppError("Ese archivo pasa de 4 GB.")
                        handle.write(piece)
                        data = data[-keep:]
                    if not fill():
                        raise engine.AppError("La carga del video se cortó.")
            saved = target
        else:
            pieces: list[bytes] = []
            while True:
                index, skip = find_marker(data, token)
                if index != -1:
                    pieces.append(data[:index])
                    data = data[index + skip:]
                    break
                keep = len(token) + 4
                if len(data) > keep:
                    pieces.append(data[:-keep])
                    data = data[-keep:]
                if not fill():
                    raise engine.AppError("La carga se cortó.")
            fields[field_name] = b"".join(pieces).decode("utf-8", "replace")

        while not data.startswith(b"--" + token) and len(data) < len(token) + 8:
            if not fill(1024):
                break
        if data.startswith(b"--" + token):
            data = data[len(token) + 2:]
        while data[:2] not in (b"--", b"\r\n", b"\n"):
            if not fill(1024):
                break
        if data.startswith(b"--"):
            break
        if data.startswith(b"\r\n"):
            data = data[2:]
        elif data.startswith(b"\n"):
            data = data[1:]
        else:
            break
    reader.read()
    return fields, saved


def new_id() -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{uuid.uuid4().hex[:6]}"


def class_dir(class_id: str) -> Path:
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{6}", class_id):
        raise engine.AppError("Clase desconocida.")
    return CLASSES / class_id


def read_meta(class_id: str) -> dict:
    path = class_dir(class_id) / "meta.json"
    if not path.is_file():
        raise engine.AppError("No encuentro esa clase.")
    return json.loads(path.read_text(encoding="utf-8"))


def write_meta(class_id: str, meta: dict) -> None:
    path = class_dir(class_id) / "meta.json"
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def update_meta(class_id: str, **changes) -> dict:
    with META_LOCK:
        meta = read_meta(class_id)
        meta.update(changes)
        write_meta(class_id, meta)
        snapshot = dict(meta)
    if {"stage", "detail", "status", "error"} & set(changes):
        try:
            cloud.note(class_id, snapshot)
        except Exception:
            traceback.print_exc()
    return snapshot


def _read_settings_file() -> dict:
    if not SETTINGS.is_file():
        return {}
    try:
        loaded = json.loads(SETTINGS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def read_settings() -> dict:
    raw = _read_settings_file()
    data = engine.coerce_settings(raw)
    legacy = "chat_provider" not in raw and isinstance(raw.get("api_key"), str) and raw.get("api_key").strip()
    if legacy:
        write_settings(data)
    return data


def write_settings(data: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sync_settings_locked() -> dict:
    """Keep the newer shared key. A failed read does not overwrite the other device."""
    raw = _read_settings_file()
    local = engine.coerce_settings(raw)
    stamp = cloud.ia_stamp(raw)
    remote = None
    remote_known = False
    if cloud.configured():
        try:
            remote = cloud.fetch_ia()
            remote_known = True
        except Exception:
            traceback.print_exc()
    if remote_known and cloud.prefer_remote(stamp, remote):
        chosen = engine.coerce_settings(remote)
        chosen["actualizado"] = cloud.ia_stamp(remote)
        if stamp != chosen["actualizado"] or local != engine.coerce_settings(chosen):
            write_settings(chosen)
        return engine.coerce_settings(chosen)
    if not remote_known or (not local.get("chat_key") and not local.get("stt_key")):
        return local
    if not stamp:
        stamp = int(datetime.now().timestamp())
    stored = dict(local)
    stored["actualizado"] = stamp
    if cloud.ia_stamp(raw) != stamp:
        write_settings(stored)
    remote_same = (
        isinstance(remote, dict)
        and cloud.ia_stamp(remote) == stamp
        and engine.coerce_settings(remote) == local
    )
    if not remote_same:
        try:
            cloud.push_ia(stored)
        except Exception:
            traceback.print_exc()
    return local


def sync_settings() -> dict:
    with SETTINGS_LOCK:
        return _sync_settings_locked()


def status_payload() -> dict:
    payload = engine.public_config(sync_settings())
    payload["ffmpeg"] = shutil.which("ffmpeg") is not None
    payload["youtube"] = youtube_up.public_status()
    return payload


def store_settings(posted: dict) -> dict:
    with SETTINGS_LOCK:
        current = _sync_settings_locked()
        merged = engine.merge_settings(current, posted)
        merged["actualizado"] = int(datetime.now().timestamp())
        write_settings(merged)
        try:
            cloud.push_ia(merged)
        except Exception:
            traceback.print_exc()
        payload = engine.public_config(merged)
    payload["ffmpeg"] = shutil.which("ffmpeg") is not None
    payload["youtube"] = youtube_up.public_status()
    return payload


def chat_lock(class_id: str) -> threading.Lock:
    with META_LOCK:
        lock = CHAT_LOCKS.get(class_id)
        if lock is None:
            lock = threading.Lock()
            CHAT_LOCKS[class_id] = lock
        return lock


def read_json(path: Path, fallback):
    if not path.is_file():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def recover_interrupted() -> None:
    if not CLASSES.is_dir():
        return
    for folder in CLASSES.iterdir():
        meta_path = folder / "meta.json"
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if meta.get("status") == "processing":
            meta["status"] = "error"
            meta["error"] = "Se cerró ClaseClara antes de terminar. Pulsa Reintentar."
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def public_meta(meta: dict) -> dict:
    watched = engine.youtube_url(meta.get("youtube_url") or "")
    class_id = str(meta.get("id") or "")
    if watched:
        youtube_state = "listo"
    elif meta.get("youtube_error"):
        youtube_state = "error"
    elif class_id in YOUTUBE_UPLOADS:
        youtube_state = "subiendo"
    elif not youtube_up.configured():
        youtube_state = "falta"
    else:
        youtube_state = ""
    return {
        "id": meta.get("id"),
        "title": meta.get("title") or "Clase",
        "materia": meta.get("materia") or "",
        "status": meta.get("status") or "error",
        "stage": meta.get("stage") or "",
        "detail": meta.get("detail") or "",
        "error": meta.get("error") or "",
        "created": meta.get("created") or "",
        "fecha": engine.fecha_iso(str(meta.get("fecha") or "")),
        "duration": meta.get("duration") or 0,
        "title_custom": bool(meta.get("title_custom")),
        "frames": meta.get("frames") or [],
        "started": meta.get("started") or 0,
        "media_kind": "youtube" if watched else "",
        "media_src": watched,
        "youtube_state": youtube_state,
        "youtube_error": str(meta.get("youtube_error") or "")[:300],
    }


def list_classes() -> list[dict]:
    if not CLASSES.is_dir():
        return []
    rows = []
    for folder in CLASSES.iterdir():
        if not (folder / "meta.json").is_file():
            continue
        try:
            meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        meta = completar_fecha(folder.name, meta)
        row = public_meta(meta)
        row["curso_id"] = str(meta.get("curso_id") or "")
        study = read_json(folder / "study.json", None)
        if isinstance(study, dict) and isinstance(study.get("avisos"), list):
            row["avisos"] = len(study["avisos"])
        rows.append(row)
    rows.sort(key=lambda row: row.get("created") or "", reverse=True)
    return rows


def course_catalog() -> dict:
    try:
        rows = cloud.list_cursos()
    except engine.AppError:
        rows = []
    items = [
        {"id": row.get("id"), "nombre": row.get("nombre") or ""}
        for row in rows
        if row.get("id")
    ]
    return {"items": items}


def attach_courses(rows: list[dict]) -> list[dict]:
    try:
        remote = cloud.curso_por_clase()
    except engine.AppError:
        remote = {}
    names = {item["id"]: item["nombre"] for item in course_catalog()["items"]}
    for row in rows:
        curso_id = remote.get(str(row.get("id") or "")) or row.get("curso_id") or ""
        row["curso_id"] = curso_id
        row["curso"] = names.get(curso_id, "")
    return rows


def remember_course(class_id: str, curso_id: str) -> None:
    curso = cloud._curso_id(curso_id)
    if not curso:
        raise engine.AppError("Elige un curso.")
    update_meta(class_id, curso_id=curso)
    try:
        cloud.asignar_curso(class_id, curso)
    except engine.AppError:
        return


def zoom_recordings() -> list[dict]:
    root = Path.home() / "Documents" / "Zoom"
    if not root.is_dir():
        return []
    rows = []
    for folder in root.iterdir():
        if not folder.is_dir():
            continue
        videos = sorted(folder.glob("video*.mp4"))
        audios = sorted(folder.glob("audio*.m4a"))
        media = videos[0] if videos else (audios[0] if audios else None)
        if media is None:
            continue
        stat = media.stat()
        rows.append({
            "name": folder.name,
            "path": str(media),
            "size_mb": round(stat.st_size / (1024 * 1024), 1),
            "when": datetime.fromtimestamp(stat.st_mtime).strftime("%d/%m/%Y %H:%M"),
            "mtime": stat.st_mtime,
        })
    rows.sort(key=lambda row: row["mtime"], reverse=True)
    return [{"name": row["name"], "path": row["path"], "size_mb": row["size_mb"], "when": row["when"]} for row in rows[:40]]


def media_kind(path: Path) -> str | None:
    if not path.is_file():
        return None
    if path.suffix.lower() in VIDEO_EXT:
        return "video"
    if path.suffix.lower() in engine.AUDIO_EXT:
        return "audio"
    return None


def completar_fecha(class_id: str, meta: dict) -> dict:
    saved = engine.fecha_iso(str(meta.get("fecha") or ""))
    if meta.get("fecha_custom") and saved:
        if saved != meta.get("fecha"):
            return update_meta(class_id, fecha=saved)
        return meta
    if saved and meta.get("fecha_origen") in {"embedded", "name", "archivo", "mtime", "edit"}:
        return meta
    source = Path(str(meta.get("source") or ""))
    iso, origin = engine.fecha_de_video(source, usar_mtime=source.name.lower() != "fuente.mp4")
    if not iso or (iso == saved and origin == meta.get("fecha_origen")):
        return meta
    updated = update_meta(class_id, fecha=iso, fecha_origen=origin, fecha_custom=False)
    try:
        cloud.save_fecha(class_id, iso, False)
    except Exception:
        traceback.print_exc()
    return updated


def set_fecha(class_id: str, raw: str) -> dict:
    iso = engine.fecha_iso(raw)
    if not iso:
        raise engine.AppError("Escribe una fecha válida.")
    updated = update_meta(class_id, fecha=iso, fecha_custom=True, fecha_origen="edit")
    try:
        cloud.save_fecha(class_id, iso, True)
    except Exception:
        traceback.print_exc()
    return public_meta(updated)


def completar_fechas() -> None:
    if not CLASSES.is_dir():
        return
    for folder in CLASSES.iterdir():
        meta_path = folder / "meta.json"
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{6}", folder.name):
            continue
        try:
            completar_fecha(folder.name, meta)
        except engine.AppError:
            continue


def class_detail(class_id: str) -> dict:
    meta = completar_fecha(class_id, read_meta(class_id))
    folder = class_dir(class_id)
    transcript = read_json(folder / "transcript.json", {})
    study = read_json(folder / "study.json", None)
    chat = read_json(folder / "chat.json", [])
    lines = transcript.get("lines") or []
    corpus = transcript.get("text") or ""
    if not corpus:
        corpus = "\n".join(line.get("text") or "" for line in lines if isinstance(line, dict))
    if isinstance(study, dict) and engine.tree_has_broken(study):
        study = engine.repair_tree(study, corpus)
        (folder / "study.json").write_text(
            json.dumps(study, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    if isinstance(chat, list) and engine.tree_has_broken(chat):
        chat = engine.repair_tree(chat, corpus)
        (folder / "chat.json").write_text(
            json.dumps(chat, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    if isinstance(study, dict):
        study = engine.place_youtube(study, lines)
        study["links"] = engine.collect_links(study, lines)
        changed = engine.stamp_points(study, meta.get("frames") or [], lines)
        changed = engine.stamp_topics(study, meta.get("frames") or [], lines) or changed
        if changed:
            (folder / "study.json").write_text(
                json.dumps(study, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    source = Path(meta.get("source") or "")
    payload = public_meta(meta)
    payload["curso_id"] = str(meta.get("curso_id") or "")
    attach_courses([payload])
    if payload.get("media_kind") != "youtube":
        payload["media_kind"] = media_kind(source)
        payload["media_src"] = ""
    payload.update({
        "study": study,
        "lines": lines,
        "chat": chat if isinstance(chat, list) else [],
    })
    return payload


def cancelled(class_id: str) -> bool:
    return class_id in CANCELLED


def run_job(class_id: str) -> None:
    ACTIVE.add(class_id)
    try:
        meta = read_meta(class_id)
        source = Path(meta["source"])
        media, audio_override = engine.resolve_source(source)
        cfg = engine.config_for_job(sync_settings())
        folder = class_dir(class_id)
        duration = engine.probe_duration(media if engine.has_video(media) else (audio_override or media))
        update_meta(class_id, duration=duration, status="processing", error="", started=int(datetime.now().timestamp()))
        transcript_path = folder / "transcript.json"
        reuse = bool(meta.get("reuse_transcript")) and transcript_path.is_file()
        frames_path = folder / "frames"
        have_frames = bool(meta.get("frames")) and frames_path.is_dir() and any(frames_path.glob("*.jpg"))

        def do_transcript() -> None:
            if cancelled(class_id) or reuse:
                return
            update_meta(
                class_id,
                stage="audio",
                detail="Comprimiendo el audio para transcribirlo rápido",
            )
            audio_src = audio_override or media
            audio_mp3 = folder / "work" / "audio.mp3"
            engine.extract_audio(audio_src, audio_mp3)
            if cancelled(class_id):
                return
            update_meta(class_id, stage="transcript", detail="Transcribiendo lo que se dijo")
            result = engine.transcribe(
                audio_mp3,
                engine.parse_keyterms(meta.get("terms") or "", meta.get("materia") or ""),
                cfg,
            )
            lines = engine.group_lines(result)
            if not lines:
                raise engine.AppError("La transcripción llegó vacía.")
            transcript_path.write_text(
                json.dumps(
                    {
                        "text": result.get("text") or "",
                        "language": result.get("language") or "",
                        "lines": lines,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            audio_mp3.unlink(missing_ok=True)

        def do_frames() -> list[dict]:
            if cancelled(class_id):
                return []
            if reuse and have_frames:
                return meta.get("frames") or []
            if not engine.has_video(media):
                return []
            update_meta(class_id, stage="frames", detail="Buscando la pizarra y las diapositivas")
            shots = engine.extract_frames(media, frames_path, duration)
            update_meta(class_id, frames=shots)
            return shots

        if reuse and have_frames:
            shots = meta.get("frames") or []
        elif reuse:
            shots = do_frames()
        else:
            update_meta(
                class_id,
                stage="transcript",
                detail="Transcribiendo el audio y apartando las capturas que cambian",
            )
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=2) as pool:
                transcript_job = pool.submit(do_transcript)
                frame_job = pool.submit(do_frames)
                transcript_job.result()
                shots = frame_job.result()
        if cancelled(class_id):
            return
        transcript = read_json(transcript_path, {})
        lines = transcript.get("lines") or []
        if not lines:
            raise engine.AppError("No quedó transcripción para armar la explicación.")
        update_meta(class_id, stage="study", detail="Escribiendo la explicación y el esquema")
        study = engine.build_study(
            meta.get("materia") or "",
            duration,
            lines,
            shots,
            frames_path,
            cfg,
        )
        if cancelled(class_id):
            return
        fresh = read_meta(class_id)
        model_title = (study.get("titulo") or "").strip() or fresh.get("title") or "Clase"
        if fresh.get("title_custom") and (fresh.get("title") or "").strip():
            saved_title = fresh["title"].strip()
        else:
            saved_title = model_title
        study["titulo"] = saved_title
        course = engine.apply_course(fresh, study)
        (folder / "study.json").write_text(json.dumps(study, ensure_ascii=False, indent=2), encoding="utf-8")
        update_meta(
            class_id,
            status="ready",
            stage="ready",
            detail="Listo",
            title=saved_title,
            materia=course,
            error="",
            frames=shots,
        )
        print(f"[ClaseClara] {class_id} lista", flush=True)
        try:
            cloud.publish(class_id)
        except Exception:
            traceback.print_exc()
    except Exception as exc:
        message = str(exc).strip() or "No se pudo preparar la clase."
        print(f"[ClaseClara] {class_id} error: {message}", flush=True)
        traceback.print_exc()
        try:
            if class_id not in CANCELLED:
                update_meta(class_id, status="error", stage="error", error=message[:700], detail="")
                try:
                    cloud.mark(class_id, "error", message[:300])
                except Exception:
                    traceback.print_exc()
        except engine.AppError:
            pass
    finally:
        ACTIVE.discard(class_id)
        if class_id in CANCELLED:
            shutil.rmtree(CLASSES / class_id, ignore_errors=True)
            CANCELLED.discard(class_id)


def launch(class_id: str) -> None:
    threading.Thread(target=run_job, args=(class_id,), daemon=True).start()


def _youtube_job(class_id: str) -> None:
    try:
        meta = read_meta(class_id)
        source = Path(str(meta.get("source") or ""))
        title = str(meta.get("title") or source.stem or "Clase")
        print(f"[ClaseClara] subiendo {class_id} a YouTube", flush=True)
        watch = youtube_up.upload(source, title)
        update_meta(class_id, youtube_url=watch, youtube_error="")
        try:
            fresh = read_meta(class_id)
            cloud.link_youtube(
                class_id,
                watch,
                str(fresh.get("title") or title),
                str(fresh.get("materia") or ""),
                str(fresh.get("status") or ""),
            )
        except Exception:
            traceback.print_exc()
        print(f"[ClaseClara] {class_id} quedó en YouTube", flush=True)
    except Exception as exc:
        message = str(exc).strip() or "No se pudo subir el video a YouTube."
        print(f"[ClaseClara] YouTube {class_id}: {message}", flush=True)
        try:
            update_meta(class_id, youtube_error=message[:300])
        except Exception:
            traceback.print_exc()
    finally:
        with YOUTUBE_LOCK:
            YOUTUBE_UPLOADS.discard(class_id)


def start_youtube(class_id: str) -> None:
    try:
        meta = read_meta(class_id)
    except engine.AppError:
        return
    if engine.youtube_url(meta.get("youtube_url") or ""):
        return
    if meta.get("youtube_error"):
        return
    source = Path(str(meta.get("source") or ""))
    if not source.is_file() or not youtube_up.configured():
        return
    with YOUTUBE_LOCK:
        if class_id in YOUTUBE_UPLOADS:
            return
        YOUTUBE_UPLOADS.add(class_id)
    threading.Thread(target=_youtube_job, args=(class_id,), daemon=True).start()


def queue_youtube() -> None:
    if not youtube_up.configured() or not CLASSES.is_dir():
        return
    for folder in CLASSES.iterdir():
        if not (folder / "meta.json").is_file():
            continue
        start_youtube(folder.name)


class DuplicateClass(engine.AppError):
    def __init__(self, message: str, class_id: str, tipo: str = "video") -> None:
        super().__init__(message)
        self.class_id = class_id
        self.tipo = tipo


def filas_locales() -> list[dict]:
    rows = []
    if not CLASSES.is_dir():
        return rows
    for folder in CLASSES.iterdir():
        meta_path = folder / "meta.json"
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        status = str(meta.get("status") or "")
        if status == "ready":
            estado = "lista"
        elif status == "processing":
            estado = "procesando"
        else:
            estado = status or "lista"
        rows.append({
            "id": str(meta.get("id") or folder.name),
            "titulo": meta.get("title") or "Clase",
            "video_url": meta.get("video_url") or meta.get("youtube_url") or "",
            "estudio": {"fuentes": cloud.fuentes_de_meta(meta)},
            "estado": estado,
            "creado": str(meta.get("created") or ""),
        })
    return rows


def duplicado_de(claves, excepto: str = "") -> dict | None:
    rows = filas_locales()
    try:
        rows.extend(cloud.filas_fuentes())
    except engine.AppError:
        pass
    return cloud.fila_duplicada(rows, claves, excepto)


def exigir_unico(claves, excepto: str = "") -> None:
    found = duplicado_de(claves, excepto)
    if not found:
        return
    raise DuplicateClass(
        cloud.aviso_duplicado(found.get("titulo") or "Clase", found.get("tipo") or "video"),
        str(found.get("id") or ""),
        str(found.get("tipo") or "video"),
    )


def claves_consulta(body: dict) -> list[str]:
    claves: list[str] = []
    url = str(body.get("url") or "").strip()
    if url:
        claves.extend(cloud.fuentes_de_url(url))
    raw_path = str(body.get("path") or "").strip().strip('"')
    if raw_path:
        path = Path(raw_path)
        if path.is_file():
            claves.extend(cloud.fuentes_de_meta({
                "source": str(path),
                "title": path.stem,
                "video_url": "",
                "fuentes": [],
            }))
    name = str(body.get("name") or "")
    try:
        size = int(body.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if name:
        claves.append(cloud.fuente_archivo(name, size))
    huella = str(body.get("huella") or "").strip()
    if huella.startswith("huella:") and cloud.clave_valida(huella):
        claves.append(huella)
    return cloud.limpiar_fuentes(claves)


def detener_pendiente(class_id: str, row: dict, found: dict) -> bool:
    estado = str(found.get("estado") or "")
    if estado and estado != "pendiente":
        return True
    propio = str(row.get("creado") or "")
    otro = str(found.get("creado") or "")
    if propio and otro and propio != otro:
        return propio > otro
    return class_id > str(found.get("id") or "")


def recordar_fuentes() -> None:
    if not CLASSES.is_dir():
        return
    for folder in CLASSES.iterdir():
        if not (folder / "meta.json").is_file():
            continue
        try:
            meta = read_meta(folder.name)
        except (OSError, json.JSONDecodeError, engine.AppError):
            continue
        claves = cloud.fuentes_de_meta(meta)
        if claves and claves != meta.get("fuentes"):
            try:
                update_meta(folder.name, fuentes=claves)
            except engine.AppError:
                continue
        publicas = cloud.limpiar_fuentes(claves, publicas=True)
        if not publicas:
            continue
        try:
            cloud.guardar_fuentes(folder.name, publicas)
        except Exception:
            traceback.print_exc()


def create_class_from_url(url: str, materia: str, terms: str, curso_id: str = "") -> str:
    cleaned = cloud.assert_zoom_url(url)
    exigir_unico(cloud.fuentes_de_url(cleaned))
    class_id = new_id()
    folder = class_dir(class_id)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / "work" / "fuente.mp4"
    try:
        cloud.download(cleaned, dest)
        meta = {
            "id": class_id,
            "title": "Clase por enlace",
            "source": str(dest.resolve()),
            "video_url": cleaned,
            "materia": materia.strip()[:120],
            "terms": terms.strip()[:400],
            "created": datetime.now().isoformat(timespec="seconds"),
            "status": "processing",
            "stage": "audio",
            "detail": "Preparando el video",
            "error": "",
            "duration": 0,
            "frames": [],
            "reuse_transcript": False,
            "started": int(datetime.now().timestamp()),
            "curso_id": cloud._curso_id(curso_id),
        }
        iso, origin = engine.fecha_de_video(dest, usar_mtime=False)
        if iso:
            meta["fecha"] = iso
            meta["fecha_origen"] = origin
            meta["fecha_custom"] = False
        meta["fuentes"] = cloud.fuentes_de_meta(meta)
        write_meta(class_id, meta)
        print(f"[ClaseClara] empieza {class_id} desde un enlace", flush=True)
        launch(class_id)
        start_youtube(class_id)
        return class_id
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def adopt_pending() -> None:
    for row in cloud.pending():
        class_id = str(row.get("id") or "")
        try:
            folder = class_dir(class_id)
        except engine.AppError:
            continue
        if class_id in ACTIVE:
            continue
        if (folder / "study.json").is_file():
            try:
                cloud.publish(class_id)
            except engine.AppError:
                pass
            continue
        fuente = folder / "work" / "fuente.mp4"
        if (folder / "meta.json").is_file() and fuente.is_file():
            try:
                status = read_meta(class_id).get("status")
            except (OSError, json.JSONDecodeError, engine.AppError):
                status = ""
            if status in {"processing", "error"}:
                update_meta(
                    class_id,
                    status="processing",
                    stage="audio",
                    detail="Preparando el video",
                    error="",
                )
                ACTIVE.add(class_id)
                print(f"[ClaseClara] retoma {class_id} desde el teléfono", flush=True)
                launch(class_id)
                start_youtube(class_id)
                continue
        url = str(row.get("video_url") or "").strip()
        if not cloud.ready_source(url):
            continue
        repetido = duplicado_de(cloud.claves_de_fila(row), excepto=class_id)
        if repetido and detener_pendiente(class_id, row, repetido):
            try:
                cloud.mark(
                    class_id,
                    "error",
                    cloud.aviso_duplicado(repetido.get("titulo") or "Clase", repetido.get("tipo") or "video"),
                )
            except engine.AppError:
                pass
            continue
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / "work" / "fuente.mp4"
        try:
            cloud.mark(class_id, "procesando", "Bajando el video")
            if cloud.entrada_count(url):
                cloud.download_entrada(class_id, cloud.entrada_count(url), dest)
                saved_url = ""
            else:
                cloud.download(url, dest)
                saved_url = cloud.assert_zoom_url(url)
        except engine.AppError as exc:
            try:
                cloud.mark(class_id, "error", str(exc))
            except engine.AppError:
                pass
            continue
        estudio = row.get("estudio") if isinstance(row.get("estudio"), dict) else {}
        hinted = engine.fecha_iso(str(estudio.get("fecha_clase") or ""))
        custom = bool(estudio.get("fecha_custom")) and bool(hinted)
        if custom:
            iso, origin = hinted, "edit"
        else:
            iso, origin = engine.fecha_de_video(
                dest,
                filename=str(row.get("titulo") or ""),
                hint=hinted,
                usar_mtime=False,
            )
        meta = {
            "id": class_id,
            "title": str(row.get("titulo") or "Clase por enlace")[:140],
            "source": str(dest.resolve()),
            "video_url": saved_url,
            "materia": str(row.get("materia") or "")[:120],
            "terms": "",
            "created": datetime.now().isoformat(timespec="seconds"),
            "fecha": iso,
            "fecha_origen": origin,
            "fecha_custom": custom,
            "status": "processing",
            "stage": "audio",
            "detail": "Preparando el video",
            "error": "",
            "duration": 0,
            "frames": [],
            "reuse_transcript": False,
            "started": int(datetime.now().timestamp()),
        }
        meta["fuentes"] = cloud.fuentes_de_meta({
            **meta,
            "fuentes": cloud.claves_de_fila(row),
        })
        write_meta(class_id, meta)
        if iso and not custom:
            try:
                cloud.save_fecha(class_id, iso, False)
            except Exception:
                traceback.print_exc()
        ACTIVE.add(class_id)
        print(f"[ClaseClara] empieza {class_id} desde el teléfono", flush=True)
        launch(class_id)
        start_youtube(class_id)


def rescue_cloud() -> None:
    for class_id in cloud.processing_ids():
        if class_id in ACTIVE:
            continue
        folder = CLASSES / class_id
        if (folder / "study.json").is_file():
            try:
                cloud.publish(class_id)
            except engine.AppError:
                pass
            continue
        fuente = folder / "work" / "fuente.mp4"
        if fuente.is_file() and (folder / "meta.json").is_file():
            update_meta(
                class_id,
                status="processing",
                stage="audio",
                detail="Preparando el video",
                error="",
            )
            ACTIVE.add(class_id)
            print(f"[ClaseClara] retoma {class_id}", flush=True)
            launch(class_id)
            start_youtube(class_id)


def watch_cloud() -> None:
    import time

    time.sleep(2)
    try:
        cloud.ensure_storage()
    except Exception:
        traceback.print_exc()
    try:
        sync_settings()
    except Exception:
        traceback.print_exc()
    try:
        completar_fechas()
    except Exception:
        traceback.print_exc()
    try:
        recordar_fuentes()
    except Exception:
        traceback.print_exc()
    try:
        count = cloud.publish_ready()
        if count:
            print(f"[ClaseClara] {count} clases publicadas en Supabase", flush=True)
    except Exception:
        traceback.print_exc()
    while True:
        try:
            sync_settings()
            adopt_pending()
            rescue_cloud()
            queue_youtube()
        except Exception:
            traceback.print_exc()
        time.sleep(10)


def create_class(source: Path, materia: str, terms: str, reuse: bool = False, curso_id: str = "") -> str:
    media, _audio = engine.resolve_source(source)
    try:
        size = media.stat().st_size
    except OSError as exc:
        raise engine.AppError("No encuentro ese video.") from exc
    claves = cloud.limpiar_fuentes([
        cloud.fuente_archivo(media.name, size),
        cloud.fuente_ruta(media),
        cloud.fuente_huella(media),
    ])
    exigir_unico(claves)
    class_id = new_id()
    folder = class_dir(class_id)
    folder.mkdir(parents=True, exist_ok=True)
    meta = {
        "id": class_id,
        "title": media.stem,
        "source": str(media.resolve()),
        "materia": materia.strip()[:120],
        "terms": terms.strip()[:400],
        "created": datetime.now().isoformat(timespec="seconds"),
        "status": "processing",
        "stage": "audio",
        "detail": "Preparando el video",
        "error": "",
        "duration": 0,
        "frames": [],
        "reuse_transcript": reuse,
        "started": int(datetime.now().timestamp()),
        "curso_id": cloud._curso_id(curso_id),
    }
    iso, origin = engine.fecha_de_video(media, filename=media.name, usar_mtime=True)
    if iso:
        meta["fecha"] = iso
        meta["fecha_origen"] = origin
        meta["fecha_custom"] = False
    meta["fuentes"] = claves
    write_meta(class_id, meta)
    print(f"[ClaseClara] empieza {class_id} {media.name}", flush=True)
    launch(class_id)
    start_youtube(class_id)
    return class_id


def rename_class(class_id: str, title: str, materia: str) -> dict:
    cleaned = " ".join(title.split())[:140]
    if not cleaned:
        raise engine.AppError("Escribe un nombre.")
    meta = read_meta(class_id)
    custom = bool(meta.get("title_custom")) or cleaned != (meta.get("title") or "").strip()
    updated = update_meta(
        class_id,
        title=cleaned,
        materia=" ".join(materia.split())[:120],
        title_custom=custom,
        materia_custom=True,
    )
    study_path = class_dir(class_id) / "study.json"
    study = read_json(study_path, None)
    if isinstance(study, dict):
        study["titulo"] = cleaned
        study_path.write_text(json.dumps(study, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        cloud.publish(class_id)
    except Exception:
        traceback.print_exc()
    return public_meta(updated)


def remove_class(class_id: str) -> None:
    folder = class_dir(class_id)
    if not folder.is_dir():
        raise engine.AppError("No encuentro esa clase.")
    if class_id in ACTIVE:
        CANCELLED.add(class_id)
        return
    shutil.rmtree(folder, ignore_errors=True)
    try:
        cloud.remove(class_id)
    except Exception:
        traceback.print_exc()


def retry_class(class_id: str, retranscribe: bool) -> None:
    if class_id in ACTIVE:
        raise engine.AppError("Esa clase todavía se está preparando.")
    meta = read_meta(class_id)
    folder = class_dir(class_id)
    if retranscribe:
        for name in ("transcript.json", "study.json"):
            (folder / name).unlink(missing_ok=True)
        reuse = False
    else:
        reuse = (folder / "transcript.json").is_file()
    update_meta(
        class_id,
        status="processing",
        stage="audio",
        detail="Retomando la clase",
        error="",
        reuse_transcript=reuse,
        youtube_error="",
        started=int(datetime.now().timestamp()),
    )
    launch(class_id)
    start_youtube(class_id)


def pick_video() -> str:
    # A fully transparent owner made the file dialog invisible. It stayed open
    # behind the browser until the request gave up.
    script = r'''
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClaseClaraWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Elige el video o el audio de la clase"
$dialog.Filter = "Clase (video o audio)|*.mp4;*.mkv;*.webm;*.mov;*.m4v;*.avi;*.m4a;*.mp3;*.wav;*.aac|Todos los archivos|*.*"
$dialog.CheckFileExists = $true
$dialog.AutoUpgradeEnabled = $true
$zoom = Join-Path $env:USERPROFILE "Documents\Zoom"
if (Test-Path $zoom) { $dialog.InitialDirectory = $zoom }
$owner = New-Object System.Windows.Forms.Form
$owner.Text = "ClaseClara"
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.Size = New-Object System.Drawing.Size(420, 80)
$owner.Controls.Add((New-Object System.Windows.Forms.Label -Property @{
  Text = "Elige el video en la ventana del explorador."
  AutoSize = $true
  Location = New-Object System.Drawing.Point(16, 24)
}))
$owner.Show()
$owner.Activate()
# The browser keeps the foreground after the click, so Windows would hide this dialog behind it.
[ClaseClaraWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[ClaseClaraWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[ClaseClaraWin]::ShowWindow($owner.Handle, 9) | Out-Null
[ClaseClaraWin]::SetForegroundWindow($owner.Handle) | Out-Null
[System.Windows.Forms.Application]::DoEvents()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.FileName) }
'''
    try:
        done = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
        )
    except subprocess.TimeoutExpired as exc:
        raise engine.AppError(
            "La ventana para elegir el video estuvo abierta demasiado tiempo y se cerró. "
            "Vuelve a pulsar Elegir video, o pega la ruta del archivo."
        ) from exc
    raw = done.stdout or b""
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        text = raw.decode("utf-16", "replace")
    else:
        text = raw.decode("utf-8", "replace")
    chosen = text.strip().strip('"')
    if chosen:
        return chosen
    if done.returncode not in (0, None):
        detail = re.sub(r"\s+", " ", (done.stderr or b"").decode("utf-8", "replace"))
        detail = re.sub(r"#< CLIXML.*", "", detail).strip()
        raise engine.AppError(
            "No pude abrir el explorador. Pega la ruta del video o usa una grabación de la lista de Zoom."
            + (f" ({detail[:180]})" if detail else "")
        )
    return ""


def guess_type(path: Path) -> str:
    if path.suffix.lower() == ".js":
        return "text/javascript; charset=utf-8"
    if path.suffix.lower() == ".css":
        return "text/css; charset=utf-8"
    if path.suffix.lower() in {".html", ".htm"}:
        return "text/html; charset=utf-8"
    kind = mimetypes.guess_type(path.name)[0]
    return kind or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    server_version = "ClaseClara/1.0"

    def log_message(self, fmt: str, *args) -> None:
        if args and isinstance(args[0], str) and "/api/jobs/" in args[0]:
            return
        super().log_message(fmt, *args)

    def _json(self, code: int, payload) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _error(self, code: int, message: str) -> None:
        self._json(code, {"error": message})

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2_000_000:
            raise engine.AppError("Esa petición es demasiado grande.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            raise engine.AppError("No pude leer la petición.") from exc
        if not isinstance(data, dict):
            raise engine.AppError("No pude leer la petición.")
        return data

    def _send_path(self, path: Path, content_type: str, download_name: str | None = None) -> None:
        if not path.is_file():
            self._error(404, "No encuentro ese archivo.")
            return
        size = path.stat().st_size
        start, end = 0, size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            spec = range_header.split("=", 1)[1].split(",", 1)[0].strip()
            left, _, right = spec.partition("-")
            try:
                if left == "":
                    length = int(right)
                    start = max(0, size - length)
                else:
                    start = int(left)
                    end = int(right) if right else size - 1
            except ValueError:
                self._error(416, "Rango inválido.")
                return
            end = min(end, size - 1)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            if download_name:
                self.send_header("Content-Disposition", f'inline; filename="{download_name}"')
            self.end_headers()
            if self.command == "HEAD":
                return
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(parsed.path)
            if path == "/":
                self._send_path(STATIC / "index.html", "text/html; charset=utf-8")
                return
            static = static_target(path)
            if static is not None:
                self._send_path(static, guess_type(static))
                return
            if path == "/api/status":
                self._json(200, status_payload())
                return
            if path == "/api/classes":
                self._json(200, {"classes": attach_courses(list_classes()), "cursos": course_catalog()})
                return
            if path == "/api/zoom":
                self._json(200, {"recordings": zoom_recordings()})
                return
            job = re.fullmatch(r"/api/jobs/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})", path)
            if job:
                self._json(200, public_meta(read_meta(job.group(1))))
                return
            detail = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})", path)
            if detail:
                self._json(200, class_detail(detail.group(1)))
                return
            frame = re.fullmatch(r"/media/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/frames/(\d\d\.jpg)", path)
            if frame:
                self._send_path(class_dir(frame.group(1)) / "frames" / frame.group(2), "image/jpeg")
                return
            source = re.fullmatch(r"/media/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/source", path)
            if source:
                meta = read_meta(source.group(1))
                file = Path(meta.get("source") or "")
                kind = media_kind(file)
                if kind is None:
                    self._error(404, "El video ya no está en esa carpeta.")
                    return
                self._send_path(file, guess_type(file))
                return
            self._error(404, "No encuentro esa página.")
        except engine.AppError as exc:
            self._error(400, str(exc))
        except Exception:
            traceback.print_exc()
            self._error(500, "ClaseClara tuvo un error interno.")

    def do_POST(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path == "/api/settings":
                body = self._read_json()
                self._json(200, store_settings(body))
                return
            if path == "/api/pick":
                chosen = pick_video()
                self._json(200, {"path": chosen})
                return
            if path == "/api/youtube/connect":
                body = self._read_json()
                self._json(200, youtube_up.connect(
                    str(body.get("client_id") or ""),
                    str(body.get("client_secret") or ""),
                ))
                return
            if path == "/api/classes/duplicado":
                body = self._read_json()
                found = duplicado_de(claves_consulta(body))
                if not found:
                    self._json(200, {"duplicado": ""})
                    return
                self._json(200, {
                    "duplicado": found.get("id") or "",
                    "error": cloud.aviso_duplicado(found.get("titulo") or "Clase", found.get("tipo") or "video"),
                    "tipo": found.get("tipo") or "video",
                })
                return
            if path == "/api/classes":
                body = self._read_json()
                raw_url = str(body.get("url") or "").strip()
                materia = str(body.get("materia") or "")
                terms = str(body.get("terms") or "")
                curso_id = str(body.get("curso_id") or "")
                if raw_url:
                    class_id = create_class_from_url(raw_url, materia, terms, curso_id)
                else:
                    raw_path = str(body.get("path") or "").strip().strip('"')
                    if not raw_path:
                        raise engine.AppError("Elige un video o pega un enlace.")
                    class_id = create_class(Path(raw_path), materia, terms, curso_id=curso_id)
                self._json(200, {"id": class_id})
                return
            if path == "/api/cursos":
                body = self._read_json()
                cloud.crear_curso(str(body.get("nombre") or ""))
                self._json(200, course_catalog())
                return
            renamed_course = re.fullmatch(r"/api/cursos/([0-9a-f-]{36})", path)
            if renamed_course:
                body = self._read_json()
                cloud.renombrar_curso(renamed_course.group(1), str(body.get("nombre") or ""))
                self._json(200, course_catalog())
                return
            assigned = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/curso", path)
            if assigned:
                body = self._read_json()
                remember_course(assigned.group(1), str(body.get("curso_id") or ""))
                self._json(200, {"ok": True})
                return
            renamed = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/title", path)
            if renamed:
                body = self._read_json()
                self._json(200, rename_class(
                    renamed.group(1),
                    str(body.get("title") or ""),
                    str(body.get("materia") if body.get("materia") is not None else ""),
                ))
                return
            dated = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/fecha", path)
            if dated:
                body = self._read_json()
                self._json(200, set_fecha(dated.group(1), str(body.get("fecha") or "")))
                return
            if path == "/api/upload":
                self._upload()
                return
            retry = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/retry", path)
            if retry:
                body = self._read_json()
                retry_class(retry.group(1), bool(body.get("retranscribe")))
                self._json(200, {"id": retry.group(1)})
                return
            chat = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/chat", path)
            if chat:
                self._chat(chat.group(1))
                return
            respuesta = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/respuesta", path)
            if respuesta:
                self._respuesta(respuesta.group(1))
                return
            self._error(404, "No encuentro esa acción.")
        except DuplicateClass as exc:
            self._json(400, {"error": str(exc), "duplicado": exc.class_id, "tipo": exc.tipo})
        except engine.AppError as exc:
            self._error(400, str(exc))
        except Exception:
            traceback.print_exc()
            self._error(500, "ClaseClara tuvo un error interno.")

    def do_DELETE(self) -> None:
        try:
            match = re.fullmatch(r"/api/classes/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})", urllib.parse.urlparse(self.path).path)
            if not match:
                self._error(404, "No encuentro esa clase.")
                return
            remove_class(match.group(1))
            self._json(200, {"ok": True})
        except engine.AppError as exc:
            self._error(400, str(exc))

    def _upload(self) -> None:
        kind = self.headers.get("Content-Type") or ""
        match = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', kind, re.I)
        if not match:
            raise engine.AppError("No pude recibir el video.")
        length = int(self.headers.get("Content-Length") or 0)
        class_id = new_id()
        folder = class_dir(class_id)
        folder.mkdir(parents=True, exist_ok=True)
        try:
            fields, saved = parse_multipart(LimitedReader(self.rfile, length), match.group(1) or match.group(2), folder)
            if saved is None:
                raise engine.AppError("Falta el video.")
            nombre = str(fields.get("_filename") or "")
            claves = cloud.limpiar_fuentes([
                cloud.fuente_archivo(nombre, saved.stat().st_size),
                cloud.fuente_huella(saved),
            ])
            exigir_unico(claves)
            meta = {
                "id": class_id,
                "title": Path(fields.get("_filename") or saved.name).stem,
                "source": str(saved.resolve()),
                "materia": (fields.get("materia") or "").strip()[:120],
                "terms": (fields.get("terms") or "").strip()[:400],
                "created": datetime.now().isoformat(timespec="seconds"),
                "status": "processing",
                "stage": "audio",
                "detail": "Preparando el video",
                "error": "",
                "duration": 0,
                "frames": [],
                "reuse_transcript": False,
                "started": int(datetime.now().timestamp()),
            }
            iso, origin = engine.fecha_de_video(
                saved,
                filename=str(fields.get("_filename") or saved.name),
                hint=str(fields.get("fecha") or ""),
                usar_mtime=False,
            )
            if iso:
                meta["fecha"] = iso
                meta["fecha_origen"] = origin
                meta["fecha_custom"] = False
            meta["fuentes"] = claves
            write_meta(class_id, meta)
            launch(class_id)
            start_youtube(class_id)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        self._json(200, {"id": class_id})

    def _chat(self, class_id: str) -> None:
        body = self._read_json()
        question = str(body.get("message") or "").strip()
        if not question:
            raise engine.AppError("Escribe una pregunta.")
        if len(question) > 4000:
            raise engine.AppError("La pregunta es demasiado larga.")
        meta = read_meta(class_id)
        if meta.get("status") != "ready":
            raise engine.AppError("La clase todavía no está lista para chatear.")
        folder = class_dir(class_id)
        study = read_json(folder / "study.json", None)
        transcript = read_json(folder / "transcript.json", {})
        if not isinstance(study, dict):
            raise engine.AppError("Falta el material de la clase.")
        lines = transcript.get("lines") or []
        text = engine.lines_to_text(lines) if lines else (transcript.get("text") or "")
        with chat_lock(class_id):
            history = read_json(folder / "chat.json", [])
            if not isinstance(history, list):
                history = []
            reply = engine.answer(
                study,
                text,
                meta.get("materia") or "",
                history,
                question,
                engine.config_for_chat(sync_settings()),
            )
            history.append({"role": "user", "content": question})
            history.append({"role": "assistant", "content": reply})
            (folder / "chat.json").write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                cloud.publish(class_id)
            except Exception:
                traceback.print_exc()
        self._json(200, {"reply": reply, "chat": history})

    def _respuesta(self, class_id: str) -> None:
        body = self._read_json()
        try:
            indice = int(body.get("indice"))
        except (TypeError, ValueError):
            raise engine.AppError("Esa tarea no está en la clase.")
        if indice < 0:
            raise engine.AppError("Esa tarea no está en la clase.")
        meta = read_meta(class_id)
        if meta.get("status") != "ready":
            raise engine.AppError("La clase todavía no está lista.")
        folder = class_dir(class_id)
        study = read_json(folder / "study.json", None)
        if not isinstance(study, dict):
            raise engine.AppError("Falta el material de la clase.")
        avisos = study.get("avisos") or []
        if indice >= len(avisos) or not isinstance(avisos[indice], dict):
            raise engine.AppError("Esa tarea no está en la clase.")
        aviso = avisos[indice]
        if aviso.get("tipo") != "tarea":
            raise engine.AppError("Esto no es una tarea.")
        transcript = read_json(folder / "transcript.json", {})
        lines = transcript.get("lines") or []
        text = engine.lines_to_text(lines) if lines else (transcript.get("text") or "")
        result = engine.respuesta_de_tarea(
            study,
            text,
            meta.get("materia") or "",
            aviso,
            engine.config_for_chat(sync_settings()),
        )
        self._json(200, result)


def make_server(port: int) -> ThreadingHTTPServer:
    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def serve(open_browser: bool = True) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    CLASSES.mkdir(parents=True, exist_ok=True)
    recover_interrupted()
    server = None
    port = 8765
    for candidate in range(8765, 8775):
        try:
            server = make_server(candidate)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("No pude abrir un puerto local entre 8765 y 8774.")
    url = f"http://127.0.0.1:{port}"
    threading.Thread(target=watch_cloud, daemon=True).start()
    print(f"ClaseClara en {url}", flush=True)
    print("Deja esta ventana abierta. Ciérrala cuando termines.", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nClaseClara cerrada.", flush=True)
    finally:
        server.server_close()


def static_target(path: str) -> Path | None:
    rel = path[len("/static/"):] if path.startswith("/static/") else path.lstrip("/")
    if not rel or rel.endswith("/"):
        return None
    target = (STATIC / rel).resolve()
    root = STATIC.resolve()
    if target != root and not str(target).startswith(str(root) + os.sep):
        return None
    if not target.is_file():
        return None
    return target


def self_test() -> None:
    engine.self_test()
    cloud.self_test()
    youtube_up.self_test()
    body = (
        b"--BOUND\r\n"
        b'Content-Disposition: form-data; name="terms"\r\n\r\n'
        b"fotosintesis\r\n"
        b"--BOUND\r\n"
        b'Content-Disposition: form-data; name="file"; filename="clase.mp4"\r\n'
        b"Content-Type: video/mp4\r\n\r\n"
        b"XYZ\r\n--not-the-end\r\n"
        b"--BOUND--\r\n"
    )

    class SliceReader(LimitedReader):
        def read(self, size: int = -1) -> bytes:
            return super().read(3 if size < 0 else min(3, size))

    import io
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        fields, saved = parse_multipart(SliceReader(io.BytesIO(body), len(body)), "BOUND", folder)
        assert fields["terms"] == "fotosintesis"
        assert saved is not None
        assert saved.read_bytes() == b"XYZ\r\n--not-the-end"

    server = make_server(0)
    port = server.server_address[1]
    real_push = cloud.push_ia
    real_fetch = cloud.fetch_ia
    def _fetch_blocked():
        raise engine.AppError("prueba sin red")

    cloud.push_ia = lambda raw: None
    cloud.fetch_ia = _fetch_blocked
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings_backup = SETTINGS.read_bytes() if SETTINGS.is_file() else None
    try:
        import urllib.request

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as response:
            page = response.read()
            assert response.status == 200
            assert b"ClaseClara" in page
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/static/styles.css") as response:
            assert b"--ink" in response.read()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status") as response:
            status = json.loads(response.read().decode("utf-8"))
            assert "has_key" in status
            assert status["ffmpeg"] is True
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/zoom") as response:
            zoom = json.loads(response.read().decode("utf-8"))
            assert "recordings" in zoom
        sample = Path(tempfile.mkdtemp()) / "tiny.mp4"
        sample.write_bytes(b"0123456789abcdef")
        class_id = new_id()
        folder = class_dir(class_id)
        folder.mkdir(parents=True)
        meta = {
            "id": class_id,
            "title": "prueba",
            "source": str(sample),
            "materia": "",
            "status": "ready",
            "stage": "ready",
            "detail": "",
            "error": "",
            "created": datetime.now().isoformat(timespec="seconds"),
            "duration": 1,
            "frames": [],
        }
        write_meta(class_id, meta)
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/media/{class_id}/source",
            headers={"Range": "bytes=0-3"},
        )
        with urllib.request.urlopen(request) as response:
            assert response.status == 206
            assert response.read() == b"0123"
        shutil.rmtree(folder, ignore_errors=True)
        sample.unlink(missing_ok=True)
        sample.parent.rmdir()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/settings",
            data=json.dumps({
                "chat_provider": "openai",
                "chat_key": "sk-test-secret-do-not-leak",
                "chat_model": "gpt-4.1",
                "stt_provider": "same",
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request) as response:
            saved = json.loads(response.read().decode("utf-8"))
        assert "sk-test-secret-do-not-leak" not in json.dumps(saved)
        assert saved["ready"] is True
        assert saved["chat"]["provider"] == "openai"
        assert "providers" in saved
    finally:
        cloud.push_ia = real_push
        cloud.fetch_ia = real_fetch
        if settings_backup is None:
            SETTINGS.unlink(missing_ok=True)
        else:
            SETTINGS.write_bytes(settings_backup)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        self_test()
        print("app ok")
    else:
        serve("--no-browser" not in sys.argv)

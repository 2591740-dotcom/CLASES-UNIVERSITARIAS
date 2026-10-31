"""Texto y diapositivas en Supabase. El video solo pasa un momento para prepararlo."""

from __future__ import annotations

import hashlib
import json
import re
import time
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


def _marca(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return 0
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def elegir_titulo(
    local_title: str,
    local_custom: bool,
    local_at: object,
    study_title: str,
    remote_title: str,
    remote_custom: bool,
    remote_at: object,
) -> tuple[str, bool, int]:
    """Elige el nombre que se queda. Si los dos se editaron, gana el más reciente."""
    local = " ".join(str(local_title or "").split())[:140]
    remote = " ".join(str(remote_title or "").split())[:140]
    study = " ".join(str(study_title or "").split())[:140]
    local_mark = _marca(local_at)
    remote_mark = _marca(remote_at)
    if remote_custom and remote and (not local_custom or remote_mark > local_mark):
        return remote, True, remote_mark
    if local_custom and local:
        return local, True, local_mark
    return (study or local or remote or "Clase"), False, 0


def _titulo_remoto(row: dict) -> tuple[str, bool, int]:
    estudio = row.get("estudio") if isinstance(row.get("estudio"), dict) else {}
    columna = " ".join(str(row.get("titulo") or "").split())[:140]
    guardado = " ".join(str(estudio.get("titulo") or "").split())[:140]
    if estudio.get("titulo_custom") and (guardado or columna):
        return (guardado or columna), True, _marca(estudio.get("titulo_en"))
    if columna and guardado and columna != guardado:
        return columna, True, 0
    return "", False, 0


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
        changed = engine.stamp_points(study, meta.get("frames") or [], lines)
        changed = engine.stamp_topics(study, meta.get("frames") or [], lines) or changed
        if changed:
            (folder / "study.json").write_text(
                json.dumps(study, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    if not isinstance(study, dict):
        study = {}
    if not isinstance(chat, list):
        chat = []
    curso = _curso_id(meta.get("curso_id") or "")
    remote_url = ""
    remote_estudio: dict = {}
    remote_title = ""
    remote_custom = False
    remote_at = 0
    remote = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=video_url,titulo,estudio",
    )
    if isinstance(remote, list) and remote:
        remote_url = str(remote[0].get("video_url") or "")
        if isinstance(remote[0].get("estudio"), dict):
            remote_estudio = remote[0]["estudio"]
        remote_title, remote_custom, remote_at = _titulo_remoto(remote[0])
    remote_fecha = engine.fecha_iso(str(remote_estudio.get("fecha_clase") or ""))
    if remote_estudio.get("fecha_custom") and remote_fecha and not meta.get("fecha_custom"):
        meta["fecha"] = remote_fecha
        meta["fecha_custom"] = True
        meta["fecha_origen"] = "edit"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    chosen, chosen_custom, chosen_at = elegir_titulo(
        str(meta.get("title") or ""),
        bool(meta.get("title_custom")),
        meta.get("titulo_en"),
        str(study.get("titulo") or ""),
        remote_title,
        remote_custom,
        remote_at,
    )
    if chosen_custom and chosen_at <= 0:
        chosen_at = int(time.time())
    meta_changed = False
    if (meta.get("title") or "") != chosen or bool(meta.get("title_custom")) != chosen_custom:
        meta["title"] = chosen
        meta["title_custom"] = chosen_custom
        meta_changed = True
    if chosen_custom and _marca(meta.get("titulo_en")) != chosen_at:
        meta["titulo_en"] = chosen_at
        meta_changed = True
    if not chosen_custom and "titulo_en" in meta:
        meta.pop("titulo_en", None)
        meta_changed = True
    if meta_changed:
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    study_path = folder / "study.json"
    if study.get("titulo") != chosen and study_path.is_file():
        study["titulo"] = chosen
        study_path.write_text(json.dumps(study, ensure_ascii=False, indent=2), encoding="utf-8")
    elif study.get("titulo") != chosen:
        study["titulo"] = chosen
    estudio = dict(study)
    fecha = engine.fecha_iso(str(meta.get("fecha") or ""))
    if fecha:
        estudio["fecha_clase"] = fecha
        estudio["fecha_custom"] = bool(meta.get("fecha_custom"))
    hora = engine.hora_valida(str(meta.get("hora") or ""))
    if not hora:
        hora = engine.hora_valida(str(remote_estudio.get("hora_clase") or ""))
    if hora:
        estudio["hora_clase"] = hora
    estudio["titulo"] = chosen
    if chosen_custom:
        estudio["titulo_custom"] = True
        estudio["titulo_en"] = chosen_at
    else:
        estudio.pop("titulo_custom", None)
        estudio.pop("titulo_en", None)
    remote_fuentes = remote_estudio.get("fuentes") if isinstance(remote_estudio.get("fuentes"), list) else []
    claves = fuentes_de_meta(meta)
    publicas = limpiar_fuentes([*claves, *remote_fuentes], publicas=True)
    if publicas:
        estudio["fuentes"] = publicas
    guardadas = meta.get("fuentes") if isinstance(meta.get("fuentes"), list) else []
    locales = limpiar_fuentes([*guardadas, *claves])
    if locales != limpiar_fuentes(guardadas):
        meta["fuentes"] = locales
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    row = {
        "id": class_id,
        "titulo": chosen[:140],
        "materia": (meta.get("materia") or "")[:120],
        "video_url": "",
        "duracion": float(meta.get("duration") or 0),
        "estudio": estudio,
        "transcripcion": transcript if isinstance(transcript, dict) else {},
        "chat": chat,
        "estado": "lista" if meta.get("status") == "ready" else (meta.get("status") or "error"),
        "detalle": (meta.get("detail") or "")[:300],
    }
    if curso:
        row["curso_id"] = curso
    row["video_url"] = choose_video_url(
        meta.get("video_url") or "",
        remote_url,
        meta.get("youtube_url") or "",
    )
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
    delete_entrada(class_id)


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


def entrada_count(url: str) -> int:
    text = str(url or "")
    if not text.startswith("entrada:"):
        return 0
    raw = text.split(":", 1)[1]
    if not raw.isdigit():
        return 0
    count = int(raw)
    if count < 1 or count > 400:
        return 0
    return count


def fuente_zoom(url: str) -> str:
    text = " ".join(str(url or "").split())
    try:
        cleaned = assert_zoom_url(text)
    except engine.AppError:
        return ""
    parts = urllib.parse.urlsplit(cleaned)
    host = (parts.hostname or "").lower()
    path = parts.path
    for marker in ("/rec/play/", "/rec/share/", "/rec/download/"):
        if marker not in path:
            continue
        token = path.split(marker, 1)[1].strip("/").split("/", 1)[0]
        if 8 <= len(token) <= 240:
            return f"zoom:{host}/{token}"
    return ""


def fuente_youtube(url: str) -> str:
    watched = engine.youtube_url(url)
    found = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", watched or "")
    if not found:
        return ""
    return f"yt:{found.group(1)}"


def fuentes_de_url(url: str) -> list[str]:
    return limpiar_fuentes([fuente_zoom(url), fuente_youtube(url)])


def fuente_archivo(name: str, size: int) -> str:
    try:
        bytes_ = int(size)
    except (TypeError, ValueError):
        return ""
    if bytes_ < 1024 or bytes_ > MAX_VIDEO:
        return ""
    stem = re.sub(r"[_-]+", " ", Path(str(name or "")).stem)
    stem = re.sub(r"\s+\(\d+\)$", "", stem)
    stem = " ".join(stem.lower().split())
    if not stem or stem in {"fuente", "video", "audio", "clase", "clase por enlace"}:
        return ""
    return f"archivo:{bytes_}:{stem[:80]}"


def fuente_ruta(path: Path) -> str:
    try:
        text = str(path.resolve()).lower()
    except OSError:
        return ""
    if len(text) < 3 or len(text) > 360:
        return ""
    return f"ruta:{text}"


def fuente_huella(path: Path) -> str:
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    if size < 1024 or size > MAX_VIDEO:
        return ""
    chunk = 1024 * 1024
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            digest.update(handle.read(chunk))
            if size > chunk:
                handle.seek(size - chunk)
                digest.update(handle.read(chunk))
    except OSError:
        return ""
    digest.update(str(size).encode("ascii"))
    return "huella:" + digest.hexdigest()[:32]


def clave_valida(key: str) -> bool:
    text = str(key or "").strip()
    if text.startswith("zoom:") and 14 <= len(text) <= 300:
        return True
    if re.fullmatch(r"yt:[A-Za-z0-9_-]{11}", text):
        return True
    if text.startswith("archivo:") and 12 <= len(text) <= 120 and text.count(":") >= 2:
        return True
    if re.fullmatch(r"huella:[0-9a-f]{32}", text):
        return True
    if text.startswith("ruta:") and 8 <= len(text) <= 400:
        return True
    return False


def limpiar_fuentes(keys, *, publicas: bool = False) -> list[str]:
    clean: list[str] = []
    for item in keys or []:
        key = str(item or "").strip()
        if not clave_valida(key) or (publicas and key.startswith("ruta:")):
            continue
        if key not in clean:
            clean.append(key)
        if len(clean) >= 8:
            break
    return clean


def fuentes_de_meta(meta: dict) -> list[str]:
    keys: list[str] = []
    stored = meta.get("fuentes")
    if isinstance(stored, list):
        keys.extend(str(item) for item in stored)
    keys.extend(fuentes_de_url(str(meta.get("video_url") or "")))
    keys.extend(fuentes_de_url(str(meta.get("youtube_url") or "")))
    source = Path(str(meta.get("source") or ""))
    if source.is_file():
        try:
            size = source.stat().st_size
        except OSError:
            size = 0
        keys.append(fuente_archivo(source.name, size))
        if source.name.lower() == "fuente.mp4":
            keys.append(fuente_archivo(str(meta.get("title") or ""), size))
        keys.append(fuente_ruta(source))
        if not any(str(item).startswith("huella:") for item in keys):
            keys.append(fuente_huella(source))
    return limpiar_fuentes(keys)


def claves_de_fila(row: dict) -> list[str]:
    keys: list[str] = []
    keys.extend(fuentes_de_url(str(row.get("video_url") or "")))
    estudio = row.get("estudio") if isinstance(row.get("estudio"), dict) else {}
    fuentes = estudio.get("fuentes") if isinstance(estudio, dict) else None
    if isinstance(fuentes, list):
        keys.extend(str(item) for item in fuentes)
    return limpiar_fuentes(keys)


def tipo_coincidencia(keys) -> str:
    if any(str(key).startswith(("zoom:", "yt:")) for key in keys):
        return "enlace"
    return "video"


def aviso_duplicado(titulo: str, tipo: str) -> str:
    nombre = " ".join(str(titulo or "Clase").split())[:80] or "Clase"
    cosa = "este enlace" if tipo == "enlace" else "este video"
    return f"Ya cargaste {cosa} en «{nombre}». Lo detengo para no prepararlo otra vez."


def fila_duplicada(rows, claves, excepto: str = "") -> dict | None:
    wanted = set(limpiar_fuentes(claves))
    if not wanted:
        return None
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        class_id = str(row.get("id") or "")
        if not class_id or class_id == excepto:
            continue
        hit = wanted.intersection(claves_de_fila(row))
        if not hit:
            continue
        titulo = row.get("titulo") or row.get("title") or "Clase"
        return {
            "id": class_id,
            "titulo": str(titulo),
            "tipo": tipo_coincidencia(hit),
            "estado": str(row.get("estado") or row.get("status") or ""),
            "creado": str(row.get("creado") or row.get("created") or ""),
        }
    return None


def filas_fuentes() -> list:
    if not configured():
        return []
    rows = _request("GET", "/rest/v1/clases?select=id,titulo,video_url,estudio,estado,creado")
    return rows if isinstance(rows, list) else []


def guardar_fuentes(class_id: str, claves) -> None:
    if not configured() or not _valid_id(class_id):
        return
    publicas = limpiar_fuentes(claves, publicas=True)
    if not publicas:
        return
    rows = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=estudio",
    )
    estudio: dict = {}
    if isinstance(rows, list) and rows and isinstance(rows[0].get("estudio"), dict):
        estudio = dict(rows[0]["estudio"])
    current = estudio.get("fuentes") if isinstance(estudio.get("fuentes"), list) else []
    merged = limpiar_fuentes([*current, *publicas], publicas=True)
    if merged == limpiar_fuentes(current, publicas=True):
        return
    estudio["fuentes"] = merged
    _request(
        "PATCH",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
        {"estudio": estudio},
        prefer="return=minimal",
    )


def public_video_url(url: str) -> str:
    text = str(url or "")
    if text.startswith("entrada:"):
        return ""
    return text


def choose_video_url(local: str, remote: str, youtube: str = "") -> str:
    for candidate in (youtube, remote, local):
        watched = engine.youtube_url(candidate)
        if watched:
            return watched
    local_public = public_video_url(local)
    if local_public:
        return local_public
    return public_video_url(remote)


def link_youtube(class_id: str, watch_url: str, title: str, materia: str, status: str) -> None:
    if not configured() or not _valid_id(class_id):
        return
    watch = engine.youtube_url(watch_url)
    if not watch:
        return
    remote = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=id",
    )
    if isinstance(remote, list) and remote:
        _request(
            "PATCH",
            f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
            {"video_url": watch},
            prefer="return=minimal",
        )
        return
    estado = "lista" if status == "ready" else ("error" if status == "error" else "procesando")
    _request(
        "POST",
        "/rest/v1/clases",
        {
            "id": class_id,
            "titulo": (title or "Clase")[:140],
            "materia": (materia or "")[:120],
            "video_url": watch,
            "duracion": 0,
            "estudio": {},
            "transcripcion": {},
            "chat": [],
            "estado": estado,
            "detalle": "Video listo para ver",
        },
        prefer="return=minimal",
    )


def ready_source(url: str) -> bool:
    if entrada_count(url):
        return True
    try:
        assert_zoom_url(url)
    except engine.AppError:
        return False
    return True


def pending() -> list[dict]:
    if not configured():
        return []
    rows = _request(
        "GET",
        "/rest/v1/clases?estado=eq.pendiente&select=id,video_url,materia,titulo,estudio,creado",
    )
    if not isinstance(rows, list):
        return []
    return [row for row in rows if ready_source(str(row.get("video_url") or ""))]


def processing_ids() -> list[str]:
    if not configured():
        return []
    rows = _request("GET", "/rest/v1/clases?estado=eq.procesando&select=id")
    if not isinstance(rows, list):
        return []
    return [str(row.get("id") or "") for row in rows if _valid_id(str(row.get("id") or ""))]


def note(class_id: str, meta: dict) -> None:
    if not configured() or not _valid_id(class_id):
        return
    status = str(meta.get("status") or "")
    if status == "ready":
        return
    if status == "error":
        mark(class_id, "error", str(meta.get("error") or "Se detuvo."))
        return
    mark(class_id, "procesando", str(meta.get("detail") or "Preparando la clase"))


def ia_stamp(raw) -> int:
    if not isinstance(raw, dict):
        return 0
    try:
        value = int(raw.get("actualizado") or 0)
    except (TypeError, ValueError):
        return 0
    if value < 0:
        return 0
    return value


def prefer_remote(local_stamp: int, remote: dict | None) -> bool:
    if not isinstance(remote, dict):
        return False
    if not str(remote.get("chat_key") or "").strip() and not str(remote.get("stt_key") or "").strip():
        return False
    remote_stamp = ia_stamp(remote)
    return remote_stamp > 0 and remote_stamp >= int(local_stamp or 0)


def push_ia(raw: dict) -> None:
    if not configured():
        return
    data = engine.coerce_settings(raw)
    if not data.get("chat_key") and not data.get("stt_key"):
        return
    stamp = ia_stamp(raw)
    if stamp:
        data["actualizado"] = stamp
    _request(
        "POST",
        "/storage/v1/object/diapositivas/" + urllib.parse.quote("ajustes/ia.json", safe="/"),
        json.dumps(data, ensure_ascii=False).encode("utf-8"),
        content_type="application/octet-stream",
        extra={"x-upsert": "true"},
    )


def fetch_ia() -> dict | None:
    """Shared settings, or None when the object is missing.

    A network failure raises, so the caller does not replace a newer key it could not read.
    """
    if not configured():
        return None
    cred = _cred()
    root = str(cred.get("url") or "").rstrip("/")
    key = str(cred.get("service_role") or "")
    if not root or not key:
        return None
    target = root + "/storage/v1/object/diapositivas/" + urllib.parse.quote("ajustes/ia.json", safe="/")
    request = urllib.request.Request(target, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:180].lower()
        if exc.code == 404 or (exc.code == 400 and "not found" in detail):
            return None
        raise engine.AppError("No pude leer la clave compartida.") from exc
    except urllib.error.URLError as exc:
        raise engine.AppError("No pude llegar a Supabase.") from exc
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    data = engine.coerce_settings(parsed)
    if not data.get("chat_key") and not data.get("stt_key"):
        return None
    data["actualizado"] = ia_stamp(parsed)
    return data


def ensure_storage() -> None:
    if not configured():
        return
    _request(
        "PUT",
        "/storage/v1/bucket/diapositivas",
        {
            "public": False,
            "file_size_limit": 52_428_800,
            "allowed_mime_types": [
                "image/jpeg",
                "image/png",
                "image/webp",
                "application/octet-stream",
            ],
        },
    )


def download_entrada(class_id: str, count: int, dest: Path) -> None:
    if not _valid_id(class_id) or count < 1:
        raise engine.AppError("No llegó el video enviado desde el teléfono.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(".part")
    total = 0
    try:
        with partial.open("wb") as handle:
            for index in range(count):
                name = f"{class_id}/entrada/{index:03d}"
                chunk = _download_object(name)
                total += len(chunk)
                if total > MAX_VIDEO:
                    raise engine.AppError("Ese video pasa de 2.5 GB.")
                handle.write(chunk)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    if total < 1000:
        partial.unlink(missing_ok=True)
        raise engine.AppError("El video enviado desde el teléfono llegó vacío.")
    partial.replace(dest)


def delete_entrada(class_id: str) -> None:
    if not configured() or not _valid_id(class_id):
        return
    try:
        _request(
            "DELETE",
            "/storage/v1/object/diapositivas",
            {"prefixes": [f"{class_id}/entrada"]},
            prefer="return=minimal",
        )
    except engine.AppError:
        return


def save_fecha(class_id: str, fecha: str, custom: bool) -> None:
    iso = engine.fecha_iso(fecha)
    if not configured() or not _valid_id(class_id) or not iso:
        return
    remote = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=estudio",
    )
    estudio: dict = {}
    if isinstance(remote, list) and remote and isinstance(remote[0].get("estudio"), dict):
        estudio = dict(remote[0]["estudio"])
    if estudio.get("fecha_custom") and not custom:
        return
    estudio["fecha_clase"] = iso
    estudio["fecha_custom"] = bool(custom)
    _request(
        "PATCH",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
        {"estudio": estudio},
        prefer="return=minimal",
    )


def save_hora(class_id: str, hora: str) -> None:
    clock = engine.hora_valida(hora)
    if not configured() or not _valid_id(class_id) or not clock:
        return
    remote = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=estudio",
    )
    estudio: dict = {}
    if isinstance(remote, list) and remote and isinstance(remote[0].get("estudio"), dict):
        estudio = dict(remote[0]["estudio"])
    if engine.hora_valida(str(estudio.get("hora_clase") or "")) == clock:
        return
    estudio["hora_clase"] = clock
    _request(
        "PATCH",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
        {"estudio": estudio},
        prefer="return=minimal",
    )


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


def _download_object(path: str) -> bytes:
    data = _cred()
    root = str(data.get("url") or "").rstrip("/")
    key = str(data.get("service_role") or "")
    if not root or not key:
        raise engine.AppError("No pude llegar a Supabase.")
    target = root + "/storage/v1/object/diapositivas/" + urllib.parse.quote(path, safe="/")
    request = urllib.request.Request(
        target,
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise engine.AppError("Faltó una parte del video enviado desde el teléfono.") from exc
    except urllib.error.URLError as exc:
        raise engine.AppError("No pude bajar el video enviado desde el teléfono.") from exc


PC_UNIVERSIDAD = "Universidad César Vallejo"
PC_CARRERA = "Psicología"


def _curso_id(value: str) -> str:
    text = str(value or "").strip().lower()
    if len(text) == 36 and text.count("-") == 4 and all(piece.isalnum() for piece in text.split("-")):
        return text
    return ""


def list_cursos() -> list[dict]:
    if not configured():
        return []
    uni = urllib.parse.quote(PC_UNIVERSIDAD)
    carrera = urllib.parse.quote(PC_CARRERA)
    rows = _request(
        "GET",
        f"/rest/v1/cursos?select=id,nombre,creado&universidad=eq.{uni}&carrera=eq.{carrera}&order=creado.asc",
    )
    return rows if isinstance(rows, list) else []


def curso_por_clase() -> dict[str, str]:
    if not configured():
        return {}
    rows = _request("GET", "/rest/v1/clases?select=id,curso_id")
    if not isinstance(rows, list):
        return {}
    return {
        str(row.get("id") or ""): str(row.get("curso_id") or "")
        for row in rows
        if row.get("id")
    }


def _nombre_curso(nombre: str) -> str:
    text = " ".join(str(nombre or "").split())
    if not text:
        raise engine.AppError("Escribe el nombre del curso.")
    if len(text) > 80:
        raise engine.AppError("El nombre del curso es muy largo.")
    return text


def crear_curso(nombre: str) -> dict:
    limpio = _nombre_curso(nombre)
    try:
        _request(
            "POST",
            "/rest/v1/cursos",
            {"universidad": PC_UNIVERSIDAD, "carrera": PC_CARRERA, "nombre": limpio},
            prefer="return=minimal",
        )
    except engine.AppError as exc:
        if "23505" in str(exc) or "duplicate" in str(exc).lower():
            raise engine.AppError("Ya hay un curso con ese nombre.") from exc
        raise
    creado = next((row for row in list_cursos() if row.get("nombre") == limpio), None)
    if not isinstance(creado, dict):
        raise engine.AppError("No pude crear el curso.")
    return creado


def renombrar_curso(curso_id: str, nombre: str) -> dict:
    curso = _curso_id(curso_id)
    if not curso:
        raise engine.AppError("No encuentro ese curso.")
    limpio = _nombre_curso(nombre)
    try:
        _request(
            "PATCH",
            f"/rest/v1/cursos?id=eq.{curso}",
            {"nombre": limpio},
            prefer="return=minimal",
        )
    except engine.AppError as exc:
        if "23505" in str(exc) or "duplicate" in str(exc).lower():
            raise engine.AppError("Ya hay un curso con ese nombre.") from exc
        raise
    return {"id": curso, "nombre": limpio}


def asignar_curso(class_id: str, curso_id: str) -> None:
    curso = _curso_id(curso_id)
    if not curso or not _valid_id(class_id):
        raise engine.AppError("Elige un curso.")
    _request(
        "PATCH",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
        {"curso_id": curso},
        prefer="return=minimal",
    )


def self_test() -> None:
    assert entrada_count("entrada:3") == 3
    assert entrada_count("entrada:0") == 0
    assert entrada_count("https://zoom.us/rec/play/abc") == 0
    assert public_video_url("entrada:2") == ""
    assert choose_video_url(
        "https://ucv-edu-pe.zoom.us/rec/play/abc.def",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ) == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert choose_video_url("https://ucv-edu-pe.zoom.us/rec/play/abc.def", "") == "https://ucv-edu-pe.zoom.us/rec/play/abc.def"
    assert choose_video_url(
        "https://ucv-edu-pe.zoom.us/rec/play/abc.def",
        "",
        "https://youtu.be/dQw4w9WgXcQ",
    ) == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert choose_video_url("", "entrada:2") == ""
    assert ready_source("entrada:1")
    assert not ready_source("")
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
    assert ia_stamp(None) == 0
    assert ia_stamp({}) == 0
    assert ia_stamp({"actualizado": "15"}) == 15
    assert ia_stamp({"actualizado": -3}) == 0
    assert not prefer_remote(10, None)
    assert not prefer_remote(10, {"chat_key": "k", "actualizado": 0})
    assert not prefer_remote(10, {"actualizado": 20})
    assert prefer_remote(10, {"chat_key": "k", "actualizado": 10})
    assert prefer_remote(10, {"stt_key": "k", "actualizado": 11})
    assert not prefer_remote(12, {"chat_key": "k", "actualizado": 11})
    token = "kw_Sxy3Jl7NRtokenXX"
    host = "ucv-edu-pe.zoom.us"
    play = f"https://{host}/rec/play/{token}?pwd=1"
    share = f"https://{host}/rec/share/{token}"
    down = f"https://{host}/rec/download/{token}/"
    zoom = fuente_zoom(play)
    assert zoom == f"zoom:{host}/{token}"
    assert zoom == fuente_zoom(share) == fuente_zoom(down)
    assert fuente_youtube("https://youtu.be/dQw4w9WgXcQ") == "yt:dQw4w9WgXcQ"
    assert fuente_youtube("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3") == "yt:dQw4w9WgXcQ"
    assert fuente_archivo("clip (1).mp4", 5000) == fuente_archivo("clip.mp4", 5000) == "archivo:5000:clip"
    assert fuente_archivo("Mi_Clase-final.mkv", 5000) == "archivo:5000:mi clase final"
    assert fuente_archivo("fuente.mp4", 5000) == ""
    assert fuente_archivo("Clase por enlace", 5000) == ""
    assert fuente_archivo("video.mp4", 500) == ""
    rows = [{
        "id": "20260101-120000-abcdef",
        "titulo": "Anatomía",
        "video_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "estudio": {"fuentes": [zoom, "yt:dQw4w9WgXcQ"]},
    }]
    found = fila_duplicada(rows, fuentes_de_url(share))
    assert found and found["id"] == rows[0]["id"] and found["tipo"] == "enlace"
    assert aviso_duplicado(found["titulo"], found["tipo"]) == (
        "Ya cargaste este enlace en «Anatomía». Lo detengo para no prepararlo otra vez."
    )
    assert fila_duplicada(rows, fuentes_de_url(share), excepto=rows[0]["id"]) is None
    assert limpiar_fuentes(["ruta:c:\\clase.mp4", zoom], publicas=True) == [zoom]
    videos = [{
        "id": "20260101-120001-abcdef",
        "titulo": "Sesión 2",
        "video_url": "",
        "estudio": {"fuentes": ["archivo:5000:clip"]},
    }]
    again = fila_duplicada(videos, [fuente_archivo("clip (1).mp4", 5000)])
    assert again and again["tipo"] == "video"
    assert "este video" in aviso_duplicado(again["titulo"], again["tipo"])
    assert fila_duplicada(videos, [fuente_archivo("otro.mp4", 5000)]) is None
    assert elegir_titulo("Auto", False, 0, "Auto", "Editado", True, 10) == ("Editado", True, 10)
    assert elegir_titulo("Mio", True, 20, "Auto", "Editado", True, 10) == ("Mio", True, 20)
    assert elegir_titulo("Mio", True, 5, "Auto", "Editado", True, 10) == ("Editado", True, 10)
    assert elegir_titulo("Mio", True, 0, "Auto", "Otro", False, 0) == ("Mio", True, 0)
    assert elegir_titulo("Archivo", False, 0, "Del modelo", "Archivo", False, 0) == ("Del modelo", False, 0)
    assert elegir_titulo("Mio", True, 10, "Auto", "", True, 30) == ("Mio", True, 10)
    assert _titulo_remoto({"titulo": "En la tarjeta", "estudio": {"titulo": "Del modelo"}}) == ("En la tarjeta", True, 0)
    assert _titulo_remoto({
        "titulo": "Viejo",
        "estudio": {"titulo": "Nuevo", "titulo_custom": True, "titulo_en": 40},
    }) == ("Nuevo", True, 40)

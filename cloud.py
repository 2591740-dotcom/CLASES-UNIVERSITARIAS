"""Texto y diapositivas en Supabase. El video solo pasa un momento para prepararlo."""

from __future__ import annotations

import gzip
import hashlib
import html
import ipaddress
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import engine

ROOT = Path(__file__).resolve().parent
CRED = ROOT / "data" / "supabase.json"
CLASSES = ROOT / "data" / "classes"
MAX_VIDEO = 2_500_000_000
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClaseClara"
_UA_PAGINA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
_MSG_CLAVE = "Esa grabación pide la clave corta de Zoom. La de Clementina no abre el video."
_MSG_SIN_ARCHIVO = "Ese enlace no entregó el video. La página de Zoom no trae el archivo."
_MSG_PAGINA = "Zoom mostró la página de la grabación y no el video."


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


def _host_publico(host: str) -> bool:
    name = (host or "").lower().rstrip(".")
    if not name or name == "localhost" or name.endswith(".local"):
        return False
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return True
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
    )


class _SoloHttps(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        absoluto = urllib.parse.urljoin(req.full_url, newurl)
        parts = urllib.parse.urlsplit(absoluto)
        if parts.scheme != "https" or not _host_publico(parts.hostname or ""):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener_zoom():
    return urllib.request.build_opener(
        _SoloHttps,
        urllib.request.HTTPCookieProcessor,
    )


def _origen(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}/"


def _cabeceras(referer: str, pagina: bool, agente: str) -> dict[str, str]:
    headers = {
        "User-Agent": agente,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8" if pagina else "*/*",
    }
    if referer:
        headers["Referer"] = referer
    return headers


def _cabeza_pagina(head: bytes) -> bool:
    sample = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return (
        sample.startswith(b"<!doctype")
        or sample.startswith(b"<html")
        or sample.startswith(b"<head")
        or sample.startswith(b"<script")
        or sample.startswith(b"<form")
        or sample.startswith(b"{")
        or sample.startswith(b"[")
    )


def _respuesta_pagina(kind: str, first: bytes) -> bool:
    if not first:
        return True
    lowered = (kind or "").lower()
    if "text/html" in lowered or "application/json" in lowered or "text/json" in lowered:
        return True
    return _cabeza_pagina(first)


def _si_gzip(raw: bytes, headers) -> bytes:
    encoding = (headers.get("Content-Encoding") or "").lower()
    if "gzip" in encoding or raw[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(raw)
        except OSError:
            return raw
    return raw


def _guardar_video(opener, url: str, dest: Path, referer: str, agente: str) -> bool:
    request = urllib.request.Request(url, headers=_cabeceras(referer, False, agente))
    with opener.open(request, timeout=60) as response:
        kind = response.headers.get("Content-Type") or ""
        first = response.read(64 * 1024)
        if _respuesta_pagina(kind, first):
            return False
        total = 0
        pending = first
        with dest.open("wb") as handle:
            while pending:
                total += len(pending)
                if total > MAX_VIDEO:
                    raise engine.AppError("Ese video pasa de 2.5 GB.")
                handle.write(pending)
                pending = response.read(1024 * 256)
    return dest.is_file() and dest.stat().st_size > 0


def _visible(texto: str) -> str:
    sin_notas = re.sub(r"(?is)<!--.*?-->", " ", str(texto or ""))
    return re.sub(r"(?is)<script\b[^>]*>.*?</script>", " ", sin_notas)


def _pide_clave_zoom(texto: str) -> bool:
    return re.search(
        r"(?is)<form\b[^>]*\b(?:id|name)\s*=\s*['\"]password_form['\"]",
        _visible(texto),
    ) is not None


def _id_seguro(value: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9_.+\-=~]{1,500}", value or "") is not None


def _bloque_llaves(texto: str) -> str:
    depth = 0
    quote = ""
    escape = False
    for index, char in enumerate(texto):
        if quote:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote:
                quote = ""
            continue
        if char in "'\"":
            quote = char
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return texto[: index + 1]
    return ""


def _leer_cadena(texto: str, index: int) -> tuple[str, int]:
    quote = texto[index]
    index += 1
    chars: list[str] = []
    while index < len(texto):
        char = texto[index]
        if char == "\\":
            if index + 1 >= len(texto):
                break
            nxt = texto[index + 1]
            mapping = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", "'": "'", '"': '"', "/": "/"}
            if nxt in mapping:
                chars.append(mapping[nxt])
                index += 2
                continue
            if nxt == "u" and index + 5 < len(texto):
                try:
                    chars.append(chr(int(texto[index + 2:index + 6], 16)))
                except ValueError:
                    chars.append(nxt)
                    index += 2
                    continue
                index += 6
                continue
            chars.append(nxt)
            index += 2
            continue
        if char == quote:
            return "".join(chars), index + 1
        chars.append(char)
        index += 1
    return "", index


def _cargar_objeto(raw: str) -> dict:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _objeto_desde_parse(rest: str) -> dict:
    abre = rest.find("(")
    if abre < 0:
        return {}
    index = abre + 1
    while index < len(rest) and rest[index].isspace():
        index += 1
    if index >= len(rest) or rest[index] not in "'\"":
        return {}
    literal, _fin = _leer_cadena(rest, index)
    return _cargar_objeto(literal)


def _objeto_data(texto: str) -> dict:
    match = re.search(r"window\.__data__\s*=\s*", texto)
    if not match:
        return {}
    rest = texto[match.end():].lstrip()
    if rest.startswith("JSON.parse"):
        data = _objeto_desde_parse(rest)
    elif rest.startswith("{"):
        data = _cargar_objeto(_bloque_llaves(rest))
    else:
        return {}
    return data if isinstance(data, dict) else {}


def _buscar_id(data: object, clave: str, depth: int = 0) -> str:
    if depth > 6 or not isinstance(data, dict):
        return ""
    value = data.get(clave)
    if isinstance(value, (str, int)) and not isinstance(value, bool):
        text = str(value).strip()
        if text:
            return text
    for child in data.values():
        found = _buscar_id(child, clave, depth + 1)
        if found:
            return found
    return ""


def _id_en_texto(texto: str, clave: str) -> str:
    match = re.search(rf"\b{re.escape(clave)}\b\s*:\s*['\"]([^'\"]+)['\"]", texto)
    if not match:
        return ""
    value = match.group(1).strip()
    return value if _id_seguro(value) else ""


def _datos_reproductor(texto: str) -> dict[str, str]:
    limpio = html.unescape(str(texto or "")).lstrip("\ufeff")
    data = _objeto_data(limpio)
    salida: dict[str, str] = {}
    for clave in ("fileId", "meetingId"):
        value = _buscar_id(data, clave)
        if not _id_seguro(value):
            value = _id_en_texto(limpio, clave)
        if _id_seguro(value):
            salida[clave] = value
    return salida


def _como_texto(valor: object) -> str:
    if isinstance(valor, str):
        return valor
    if isinstance(valor, (bytes, bytearray)):
        return bytes(valor).decode("utf-8", errors="replace")
    return ""


def _como_dict(valor: object) -> dict:
    if isinstance(valor, dict):
        return valor
    if isinstance(valor, str):
        texto = valor.strip()
        if not texto.startswith("{") and not texto.startswith("["):
            return {}
        try:
            parsed = json.loads(texto)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _interpretar(texto: str):
    limpio = texto.lstrip("\ufeff \t\r\n")
    if limpio.startswith("{") or limpio.startswith("["):
        try:
            return json.loads(limpio)
        except json.JSONDecodeError:
            return texto
    return texto


def _url_reproductor(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if "/rec/download/" not in parts.path:
        return url
    path = parts.path.replace("/rec/download/", "/rec/play/", 1)
    return urllib.parse.urlunsplit(parts._replace(path=path))


def _url_play_seguro(redirect: str, base: str) -> str:
    if not redirect:
        return ""
    absoluto = urllib.parse.urljoin(base, redirect.strip())
    parts = urllib.parse.urlsplit(absoluto)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host.endswith("zoom.us") or not _host_publico(host):
        return ""
    if "/rec/play/" not in parts.path and "/rec/share/" not in parts.path:
        return ""
    if len(absoluto) > 2000:
        return ""
    return absoluto


def _url_media(url: str, base: str) -> str:
    text = " ".join(str(url or "").split())
    if not text:
        return ""
    absoluto = urllib.parse.urljoin(base, text)
    parts = urllib.parse.urlsplit(absoluto)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or not _host_publico(host):
        return ""
    if len(absoluto) > 16000:
        return ""
    return absoluto


def _elegir_mp4(info: dict, base: str) -> str:
    result = info.get("result") if isinstance(info, dict) else None
    bolsa = result if isinstance(result, dict) else (info if isinstance(info, dict) else {})
    for clave in ("viewMp4WithshareUrl", "viewMp4Url", "shareMp4Url"):
        media = _url_media(str(bolsa.get(clave) or ""), base)
        if media:
            return media
    return ""


def _exigir_sin_clave(texto: str) -> None:
    if _pide_clave_zoom(texto):
        raise engine.AppError(_MSG_CLAVE)


# La página del reproductor no es una clave. El mp4 sale de play/info.
def _resolver_grabacion(url: str, pedir) -> str:
    cleaned = assert_zoom_url(url)
    pagina = _url_reproductor(cleaned)
    continuo = False
    html_pagina = _como_texto(pedir(pagina))
    _exigir_sin_clave(html_pagina)
    if "/rec/share/" in urllib.parse.urlsplit(pagina).path:
        meeting = _datos_reproductor(html_pagina).get("meetingId") or ""
        if not meeting:
            raise engine.AppError(_MSG_SIN_ARCHIVO)
        base = _origen(pagina)
        info = _como_dict(pedir(base + "nws/recording/1.0/play/share-info/" + urllib.parse.quote(meeting, safe="")))
        result = info.get("result") if isinstance(info.get("result"), dict) else {}
        play = _url_play_seguro(str(result.get("redirectUrl") or ""), base)
        if not play:
            raise engine.AppError(_MSG_SIN_ARCHIVO)
        html_pagina = _como_texto(pedir(play))
        _exigir_sin_clave(html_pagina)
        pagina = play
        continuo = True
    file_id = _datos_reproductor(html_pagina).get("fileId") or ""
    if not file_id:
        raise engine.AppError(_MSG_SIN_ARCHIVO)
    base = _origen(pagina)
    consulta = "?continueMode=true" if continuo else ""
    info = _como_dict(pedir(
        base + "nws/recording/1.0/play/info/" + urllib.parse.quote(file_id, safe="") + consulta
    ))
    media = _elegir_mp4(info, base)
    if not media:
        raise engine.AppError(_MSG_PAGINA)
    return media


def _pedir_zoom(opener, origen: str):
    def pedir(url: str):
        request = urllib.request.Request(url, headers=_cabeceras(origen, True, _UA_PAGINA))
        with opener.open(request, timeout=60) as response:
            raw = _si_gzip(response.read(4_000_000), response.headers)
            charset = "utf-8"
            getter = getattr(response.headers, "get_content_charset", None)
            if callable(getter):
                charset = getter() or "utf-8"
            text = raw.decode(charset, errors="replace")
        return _interpretar(text)

    return pedir


def _bajar_zoom(url: str, dest: Path, opener) -> None:
    cleaned = assert_zoom_url(url)
    target = playback_url(cleaned)
    dest.unlink(missing_ok=True)
    try:
        try:
            listo = _guardar_video(opener, target, dest, _origen(cleaned), USER_AGENT)
        except urllib.error.HTTPError as exc:
            exc.close()
            listo = False
        if not listo:
            print("[ClaseClara] Zoom entregó la página. Busco el video.", flush=True)
            media = _resolver_grabacion(cleaned, _pedir_zoom(opener, _origen(cleaned)))
            listo = _guardar_video(opener, media, dest, _origen(cleaned), _UA_PAGINA)
        if not listo:
            raise engine.AppError(_MSG_PAGINA)
    except engine.AppError:
        dest.unlink(missing_ok=True)
        raise
    except (OSError, urllib.error.URLError) as exc:
        dest.unlink(missing_ok=True)
        raise engine.AppError("No pude bajar el video desde ese enlace.") from exc
    if not dest.is_file() or dest.stat().st_size < 100_000:
        dest.unlink(missing_ok=True)
        raise engine.AppError("El enlace no devolvió un video completo.")
    head = dest.read_bytes()[:80]
    if _cabeza_pagina(head):
        dest.unlink(missing_ok=True)
        raise engine.AppError(_MSG_PAGINA)


def download(url: str, dest: Path) -> None:
    cleaned = assert_zoom_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    _bajar_zoom(cleaned, dest, _opener_zoom())


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
    if mes_bloquea(class_id):
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
    fijado = curso_fijado(meta)
    if fijado and fijado != curso:
        meta["curso_id"] = fijado
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        curso = fijado
    elif fijado:
        curso = fijado
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
    propias = presentaciones_limpias(meta.get("presentaciones"))
    if not propias:
        propias = presentaciones_limpias(estudio.get("presentaciones"))
    if not propias:
        propias = presentaciones_limpias(remote_estudio.get("presentaciones"))
    if propias:
        estudio["presentaciones"] = propias
    else:
        estudio.pop("presentaciones", None)
    lecturas = unir_lecturas(
        meta.get("lecturas") or estudio.get("lecturas"),
        remote_estudio.get("lecturas"),
    )
    if lecturas:
        estudio["lecturas"] = lecturas
    else:
        estudio.pop("lecturas", None)
    profesor = profesor_limpio(meta.get("profesor")) or profesor_limpio(estudio.get("profesor"))
    if not profesor:
        profesor = profesor_limpio(remote_estudio.get("profesor"))
    if profesor:
        estudio["profesor"] = profesor
    else:
        estudio.pop("profesor", None)
    if study_path.is_file():
        guardado = False
        for clave in ("hora_clase", "profesor", "lecturas", "presentaciones", "fecha_clase"):
            if clave in estudio and study.get(clave) != estudio[clave] and estudio[clave] not in ("", None, []):
                study[clave] = estudio[clave]
                guardado = True
        if guardado:
            study_path.write_text(json.dumps(study, ensure_ascii=False, indent=2), encoding="utf-8")
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
        if meta.get("status") == "ready" and not mes_bloquea(folder.name):
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


def url_sin_token(url: str) -> str:
    """Enlace https. En uvcv.edu.pe el archivo directo queda sin el token."""
    text = str(url or "").strip()
    if not text.startswith("https://") or len(text) > 800:
        return ""
    parts = urllib.parse.urlsplit(text)
    host = (parts.hostname or "").lower()
    if not host:
        return ""
    path = parts.path
    query = parts.query
    if host == "uvcv.edu.pe" or host.endswith(".uvcv.edu.pe"):
        path = path.replace("/webservice/pluginfile.php/", "/pluginfile.php/")
        if "/pluginfile.php/" in path:
            query = ""
    cleaned = urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, ""))
    return cleaned if cleaned.startswith("https://") and len(cleaned) <= 800 else ""


def _es_zoom(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host == "zoom.us" or host.endswith(".zoom.us")


def _archivos_limpios(value, fallback: str) -> list[dict]:
    if not isinstance(value, list):
        return []
    salida: list[dict] = []
    vistos: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        url = url_sin_token(item.get("url") or "")
        if not url or _es_zoom(url) or url in vistos:
            continue
        vistos.add(url)
        nombre = " ".join(str(item.get("nombre") or "").split())[:160] or fallback
        salida.append({"nombre": nombre, "url": url})
        if len(salida) >= 6:
            break
    return salida


_NO_LECTURA = re.compile(
    r"(?i)(?:\.(?:pptx?|ppsx?)(?:$|[?#])|\b(?:pptx?|ppsx?|diapositivas?|presentaci[oó]n(?:es)?)\b)"
)


def presentaciones_limpias(value) -> list[dict]:
    """Archivos de la sesión en Clementina. El enlace de Zoom no entra aquí."""
    return _archivos_limpios(value, "Presentación")


def lecturas_limpias(value) -> list[dict]:
    """PDF, Word y enlaces de lectura. Zoom y presentaciones no entran."""
    crudas = []
    if isinstance(value, list):
        for item in value:
            if not isinstance(item, dict):
                continue
            url = url_sin_token(item.get("url") or "")
            nombre = " ".join(str(item.get("nombre") or "").split())
            if not url or _es_zoom(url):
                continue
            if _NO_LECTURA.search(urllib.parse.unquote(url)) or _NO_LECTURA.search(nombre):
                continue
            crudas.append({"nombre": nombre, "url": url})
    return _archivos_limpios(crudas, "Lectura")


def profesor_limpio(value) -> str:
    """Nombre que trajo Clementina. El aviso de que no hay profesor no se guarda."""
    text = " ".join(str(value or "").split())
    if not text or text.casefold() == "sin profesor visible":
        return ""
    return text[:160]


def profesor_de_fuentes(meta, study, remoto) -> str:
    """El nombre ya guardado. No inventa uno ni guarda el aviso vacío."""
    fuentes = (
        meta.get("profesor") if isinstance(meta, dict) else "",
        study.get("profesor") if isinstance(study, dict) else "",
        remoto.get("profesor") if isinstance(remoto, dict) else "",
    )
    for fuente in fuentes:
        nombre = profesor_limpio(fuente)
        if nombre:
            return nombre
    return ""


_PORTADA_STOP = engine._TOPIC_STOP | {"sesion", "asincronica", "sincronica", "primer", "nombre", "plano"}
_PORTADA_GENERICA = re.compile(
    r"profesor|presentador|docente|bienvenida|participante|videollamada|"
    r"\bzoom\b|camara|video apagado|video prendido|video activado|"
    r"pantalla de inicio|pantalla inicial|pantalla negra|pantalla en blanco|"
    r"pantalla sin |nombre del |nombre en pantalla|lista de asistencia|"
    r"lista de grupos|inicio de la|fondo azul|logo |avatar"
)


def _titulo_portada(text: str) -> str:
    folded = engine._fold(text)
    folded = re.sub(r"^sesion\s+\d+\s*", "", folded)
    return folded.replace("asincronica", " ").replace("sincronica", " ")


def _palabras_portada(text: str) -> set[str]:
    return {
        word for word in re.findall(r"[a-z0-9]{4,}", engine._fold(text))
        if word not in _PORTADA_STOP
    }


def _portada_generica(text: str) -> bool:
    return bool(_PORTADA_GENERICA.search(engine._fold(text)))


def indice_portada(titulo: str, capturas) -> int:
    """Captura, desde 1, cuyo texto habla del título. 0 si ninguna lo hace."""
    buscadas = _palabras_portada(_titulo_portada(titulo))
    if not buscadas or not isinstance(capturas, list):
        return 0
    mejor = 0
    puntos = 0
    for shot in capturas:
        if not isinstance(shot, dict):
            continue
        try:
            indice = int(shot.get("indice") or 0)
        except (TypeError, ValueError):
            continue
        if indice < 1 or indice > 24:
            continue
        muestra = str(shot.get("que_muestra") or "")
        score = engine._overlap(buscadas, _palabras_portada(muestra))
        if score < 1:
            continue
        if score < 2 and _portada_generica(muestra):
            continue
        if score > puntos or (score == puntos and indice < mejor):
            puntos = score
            mejor = indice
    return mejor


def unir_lecturas(local, remoto) -> list[dict]:
    salida = lecturas_limpias(local)
    vistos = {item["url"] for item in salida}
    for item in lecturas_limpias(remoto):
        if item["url"] in vistos or len(salida) >= 6:
            continue
        salida.append(item)
        vistos.add(item["url"])
    return salida


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


def unir_presentaciones(local, remoto) -> list[dict]:
    salida = presentaciones_limpias(local)
    vistos = {item["url"] for item in salida}
    for item in presentaciones_limpias(remoto):
        if item["url"] in vistos or len(salida) >= 6:
            continue
        salida.append(item)
        vistos.add(item["url"])
    return salida


def cambios_de_remoto(meta: dict, remote: dict, study_title: str = "") -> dict:
    """Lo que la web o la APK cambiaron y esta PC todavía no tiene."""
    if not isinstance(meta, dict) or not isinstance(remote, dict):
        return {}
    estudio = remote.get("estudio") if isinstance(remote.get("estudio"), dict) else {}
    cambios: dict = {}
    remote_title, remote_custom, remote_at = _titulo_remoto(remote)
    chosen, chosen_custom, chosen_at = elegir_titulo(
        str(meta.get("title") or ""),
        bool(meta.get("title_custom")),
        meta.get("titulo_en"),
        study_title,
        remote_title,
        remote_custom,
        remote_at,
    )
    if chosen and (
        chosen != (meta.get("title") or "")
        or bool(meta.get("title_custom")) != chosen_custom
    ):
        cambios["title"] = chosen
        cambios["title_custom"] = chosen_custom
        if chosen_custom:
            cambios["titulo_en"] = chosen_at
        elif "titulo_en" in meta:
            cambios["titulo_en"] = None
    remote_fecha = engine.fecha_iso(str(estudio.get("fecha_clase") or ""))
    if estudio.get("fecha_custom") and remote_fecha and not meta.get("fecha_custom"):
        cambios["fecha"] = remote_fecha
        cambios["fecha_custom"] = True
        cambios["fecha_origen"] = "edit"
    remote_hora = engine.hora_valida(str(estudio.get("hora_clase") or ""))
    local_hora = engine.hora_valida(str(meta.get("hora") or ""))
    if remote_hora and not local_hora:
        cambios["hora"] = remote_hora
    elif remote_hora and estudio.get("fecha_custom") and not meta.get("fecha_custom"):
        cambios["hora"] = remote_hora
    local_curso = _curso_id(meta.get("curso_id") or "")
    elegido = elegir_curso_id(local_curso, remote.get("curso_id") or "", curso_fijado(meta))
    if elegido and elegido != local_curso:
        cambios["curso_id"] = elegido
    ppt = unir_presentaciones(meta.get("presentaciones"), estudio.get("presentaciones"))
    if ppt != presentaciones_limpias(meta.get("presentaciones")):
        cambios["presentaciones"] = ppt
    visto = engine.youtube_url(str(remote.get("video_url") or ""))
    if visto and not engine.youtube_url(str(meta.get("youtube_url") or "")):
        cambios["youtube_url"] = visto
    return cambios


def es_de_esta_pc(row: dict) -> bool:
    if not isinstance(row, dict):
        return False
    uni = " ".join(str(row.get("universidad") or "").split())
    carrera = " ".join(str(row.get("carrera") or "").split())
    if uni and uni != PC_UNIVERSIDAD:
        return False
    if carrera and carrera != PC_CARRERA:
        return False
    return True


_VISTA = (
    "id,titulo,materia,curso_id,video_url,duracion,estado,detalle,creado,universidad,carrera,"
    "estudio_titulo:estudio->titulo,"
    "estudio_custom:estudio->titulo_custom,"
    "estudio_en:estudio->titulo_en,"
    "estudio_fecha:estudio->fecha_clase,"
    "estudio_fecha_custom:estudio->fecha_custom,"
    "estudio_hora:estudio->hora_clase,"
    "estudio_profesor:estudio->profesor,"
    "estudio_ppt:estudio->presentaciones,"
    "estudio_avisos:estudio->avisos"
)


def _fila_ligera(row: dict) -> dict:
    ppt = row.get("estudio_ppt")
    avisos = row.get("estudio_avisos")
    return {
        "id": row.get("id"),
        "titulo": row.get("titulo") or "",
        "materia": row.get("materia") or "",
        "curso_id": row.get("curso_id") or "",
        "video_url": row.get("video_url") or "",
        "duracion": row.get("duracion") or 0,
        "estado": row.get("estado") or "",
        "detalle": row.get("detalle") or "",
        "creado": row.get("creado") or "",
        "universidad": row.get("universidad") or "",
        "carrera": row.get("carrera") or "",
        "estudio": {
            "titulo": row.get("estudio_titulo") or "",
            "titulo_custom": bool(row.get("estudio_custom")),
            "titulo_en": row.get("estudio_en") or 0,
            "fecha_clase": row.get("estudio_fecha") or "",
            "fecha_custom": bool(row.get("estudio_fecha_custom")),
            "hora_clase": row.get("estudio_hora") or "",
            "profesor": profesor_limpio(row.get("estudio_profesor")),
            "presentaciones": ppt if isinstance(ppt, list) else [],
            "avisos": avisos if isinstance(avisos, list) else [],
        },
    }


def _pedir_vista(extra: str = "") -> list:
    if not configured():
        return []
    select = urllib.parse.quote(_VISTA, safe=",:")
    rows = _request("GET", f"/rest/v1/clases?select={select}{extra}")
    if not isinstance(rows, list):
        return []
    return [_fila_ligera(row) for row in rows if isinstance(row, dict)]


def filas_vista() -> list:
    return _pedir_vista()


def leer_estado(class_id: str) -> dict | None:
    if not configured() or not _valid_id(class_id):
        return None
    rows = _pedir_vista(f"&id=eq.{urllib.parse.quote(class_id)}")
    return rows[0] if rows else None


def leer_clase(class_id: str) -> dict | None:
    if not configured() or not _valid_id(class_id):
        return None
    rows = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}"
        "&select=id,titulo,materia,curso_id,video_url,duracion,estado,detalle,creado,universidad,carrera,estudio,transcripcion,chat",
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    return None


def diapositivas_de(class_id: str) -> list:
    if not configured() or not _valid_id(class_id):
        return []
    rows = _request(
        "GET",
        f"/rest/v1/diapositivas?clase_id=eq.{urllib.parse.quote(class_id)}"
        "&select=orden,tiempo,imagen_path&order=orden.asc",
    )
    return rows if isinstance(rows, list) else []


def firmar_imagen(path: str) -> str:
    data = _cred()
    root = str(data.get("url") or "").rstrip("/")
    key = str(data.get("service_role") or "")
    name = str(path or "").strip().lstrip("/")
    if not root or not key or not name or ".." in name:
        return ""
    target = root + "/storage/v1/object/sign/diapositivas/" + urllib.parse.quote(name, safe="/")
    payload = json.dumps({"expiresIn": 3600}).encode("utf-8")
    request = urllib.request.Request(
        target,
        data=payload,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, json.JSONDecodeError, OSError):
        return ""
    signed = ""
    if isinstance(body, dict):
        signed = str(body.get("signedURL") or body.get("signedUrl") or "")
    if not signed:
        return ""
    if signed.startswith("http"):
        return signed
    return root + "/storage/v1" + signed


def marcos_firmados(class_id: str) -> list[dict]:
    try:
        slides = diapositivas_de(class_id)
    except engine.AppError:
        return []
    frames = []
    for slide in slides:
        if not isinstance(slide, dict):
            continue
        url = firmar_imagen(str(slide.get("imagen_path") or ""))
        if not url:
            continue
        try:
            tiempo = float(slide.get("tiempo") or 0)
        except (TypeError, ValueError):
            tiempo = 0
        frames.append({"file": url, "time": tiempo})
    return frames


def orden_limpio(data) -> dict:
    if not isinstance(data, dict):
        return {}
    salida = {}
    for key, ids in data.items():
        if not isinstance(ids, list):
            continue
        clean = []
        for item in ids:
            text = str(item or "")
            if _valid_id(text) and text not in clean:
                clean.append(text)
            if len(clean) >= 200:
                break
        if clean and str(key):
            salida[str(key)] = clean
    return salida


def leer_orden() -> dict:
    if not configured():
        return {}
    data = _cred()
    root = str(data.get("url") or "").rstrip("/")
    key = str(data.get("service_role") or "")
    if not root or not key:
        return {}
    target = root + "/storage/v1/object/diapositivas/" + urllib.parse.quote("ajustes/orden.json", safe="/")
    request = urllib.request.Request(target, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code in {400, 404}:
            return {}
        return {}
    except (urllib.error.URLError, json.JSONDecodeError, OSError):
        return {}
    return orden_limpio(raw)


_AJUSTES_TURNO = {"linkeo-turno.json", "linkeo-lectura.json", "linkeo-mes.json"}


def _ajuste_turno(nombre: str) -> str:
    if nombre not in _AJUSTES_TURNO:
        raise engine.AppError("No guardo ese ajuste.")
    return "ajustes/" + nombre


def leer_ajuste(nombre: str):
    """JSON privado del turno. No incluye la contraseña."""
    if not configured():
        return None
    try:
        raw = _download_object(_ajuste_turno(nombre))
    except engine.AppError:
        return None
    try:
        data = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def guardar_ajuste(nombre: str, data: dict) -> None:
    if not configured() or not isinstance(data, dict):
        return
    _request(
        "POST",
        "/storage/v1/object/diapositivas/" + urllib.parse.quote(_ajuste_turno(nombre), safe="/"),
        json.dumps(data, ensure_ascii=False).encode("utf-8"),
        content_type="application/octet-stream",
        extra={"x-upsert": "true"},
    )


def guardar_privado(nombre: str, data: dict) -> None:
    """Copia la conexión de YouTube al almacén privado. No imprime el token."""
    if nombre != "youtube.json" or not configured() or not isinstance(data, dict):
        return
    cuerpo = json.dumps({
        "client_id": str(data.get("client_id") or ""),
        "client_secret": str(data.get("client_secret") or ""),
        "refresh_token": str(data.get("refresh_token") or ""),
        "channel": str(data.get("channel") or "")[:120],
    }, ensure_ascii=False).encode("utf-8")
    _request(
        "POST",
        "/storage/v1/object/claseclara_privado/" + urllib.parse.quote(nombre, safe="/"),
        cuerpo,
        content_type="application/octet-stream",
        extra={"x-upsert": "true"},
    )


def borrar_ajuste(nombre: str) -> None:
    if not configured():
        return
    try:
        _request(
            "DELETE",
            "/storage/v1/object/diapositivas",
            {"prefixes": [_ajuste_turno(nombre)]},
            prefer="return=minimal",
        )
    except engine.AppError:
        return


def guardar_orden_curso(curso_id: str, ids) -> dict:
    curso = _curso_id(curso_id)
    if not curso:
        raise engine.AppError("Elige un curso antes de ordenar las clases.")
    clean = []
    for item in ids or []:
        text = str(item or "")
        if _valid_id(text) and text not in clean:
            clean.append(text)
        if len(clean) >= 200:
            break
    actual = leer_orden()
    actual[curso] = clean
    _request(
        "POST",
        "/storage/v1/object/diapositivas/" + urllib.parse.quote("ajustes/orden.json", safe="/"),
        json.dumps(actual, ensure_ascii=False).encode("utf-8"),
        content_type="application/octet-stream",
        extra={"x-upsert": "true"},
    )
    return actual


def guardar_titulo(class_id: str, title: str, materia: str) -> None:
    cleaned = " ".join(str(title or "").split())[:140]
    if not configured() or not _valid_id(class_id) or not cleaned:
        return
    remote = _request(
        "GET",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}&select=estudio",
    )
    estudio: dict = {}
    if isinstance(remote, list) and remote and isinstance(remote[0].get("estudio"), dict):
        estudio = dict(remote[0]["estudio"])
    estudio["titulo"] = cleaned
    estudio["titulo_custom"] = True
    estudio["titulo_en"] = int(time.time())
    _request(
        "PATCH",
        f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}",
        {
            "titulo": cleaned,
            "materia": " ".join(str(materia or "").split())[:120],
            "estudio": estudio,
        },
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


def nombre_clave(nombre: str) -> str:
    return " ".join(str(nombre or "").split()).casefold()


def elegir_curso_id(local: str, remoto: str, fijado: str = "") -> str:
    fijo = _curso_id(fijado)
    if fijo:
        return fijo
    lejos = _curso_id(remoto)
    if lejos:
        return lejos
    return _curso_id(local)


_cursos_cache: list | None = None
_cursos_en = 0.0


def _olvidar_cursos() -> None:
    global _cursos_cache
    _cursos_cache = None


def list_cursos() -> list[dict]:
    global _cursos_cache, _cursos_en
    ahora = time.monotonic()
    if _cursos_cache is not None and ahora - _cursos_en < 4:
        return _cursos_cache
    if not configured():
        return []
    uni = urllib.parse.quote(PC_UNIVERSIDAD)
    carrera = urllib.parse.quote(PC_CARRERA)
    rows = _request(
        "GET",
        f"/rest/v1/cursos?select=id,nombre,creado&universidad=eq.{uni}&carrera=eq.{carrera}&order=creado.asc",
    )
    salida = rows if isinstance(rows, list) else []
    _cursos_cache = salida
    _cursos_en = ahora
    return salida


def mapa_cursos(filas) -> dict[str, str]:
    salida: dict[str, str] = {}
    if not isinstance(filas, list):
        return salida
    for row in filas:
        if not isinstance(row, dict):
            continue
        clave = nombre_clave(row.get("nombre") or "")
        curso = _curso_id(row.get("id") or "")
        if clave and curso and clave not in salida:
            salida[clave] = curso
    return salida


def curso_id_por_nombre(nombre: str, cursos: list | None = None) -> str:
    clave = nombre_clave(nombre)
    if not clave:
        return ""
    if cursos is None:
        try:
            filas = list_cursos()
        except engine.AppError:
            return ""
    else:
        filas = cursos
    return mapa_cursos(filas).get(clave, "")


def curso_fijado(meta: dict) -> str:
    if not isinstance(meta, dict) or not meta.get("materia_custom"):
        return ""
    return curso_id_por_nombre(str(meta.get("materia") or ""))


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
    _olvidar_cursos()
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
    _olvidar_cursos()
    creado = next((row for row in list_cursos() if row.get("nombre") == limpio), None)
    if not isinstance(creado, dict):
        raise engine.AppError("No pude crear el curso.")
    return creado


def renombrar_curso(curso_id: str, nombre: str) -> dict:
    curso = _curso_id(curso_id)
    if not curso:
        raise engine.AppError("No encuentro ese curso.")
    limpio = _nombre_curso(nombre)
    _olvidar_cursos()
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


def fechas_remotas() -> list[dict]:
    if not configured():
        return []
    rows = _request("GET", "/rest/v1/clases?select=materia,curso_id,estudio")
    if not isinstance(rows, list):
        return []
    salida = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        estudio = row.get("estudio") if isinstance(row.get("estudio"), dict) else {}
        salida.append({
            "materia": str(row.get("materia") or ""),
            "curso_id": str(row.get("curso_id") or ""),
            "fecha": str(estudio.get("fecha_clase") or ""),
        })
    return salida


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


def dia_lima(epoch: float) -> str:
    momento = datetime.fromtimestamp(float(epoch), timezone.utc) - timedelta(hours=5)
    return f"{momento.year:04d}-{momento.month:02d}-{momento.day:02d}"


def corte_mes(epoch: float) -> dict | None:
    """None del día 1 al 4. Si no, el instante UTC en que empieza el mes en Lima."""
    momento = datetime.fromtimestamp(float(epoch), timezone.utc) - timedelta(hours=5)
    if momento.day < 5:
        return None
    inicio = datetime(momento.year, momento.month, 1, 5, 0, 0, tzinfo=timezone.utc)
    return {
        "mes": f"{momento.year:04d}-{momento.month:02d}",
        "dia": momento.day,
        "inicio": int(inicio.timestamp()),
    }


def instante(valor: str) -> int:
    text = str(valor or "").strip()
    if not text:
        return 0
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    elif "T" in text and not re.search(r"[+-]\d{2}:?\d{2}$", text):
        text += "+00:00"
    try:
        momento = datetime.fromisoformat(text)
    except ValueError:
        return 0
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=timezone.utc)
    return int(momento.timestamp())


def epoch_de_id(class_id: str) -> int:
    match = re.fullmatch(r"(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{6}", str(class_id or ""))
    if not match:
        return 0
    year, month, day, hour, minute, second = (int(pieza) for pieza in match.groups())
    try:
        marca = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError:
        return 0
    return int(marca.timestamp()) + 5 * 3600


def clase_vencida(row, inicio: int) -> bool:
    if not isinstance(row, dict) or not _valid_id(str(row.get("id") or "")):
        return False
    stamp = instante(str(row.get("creado") or "")) or epoch_de_id(str(row.get("id") or ""))
    return bool(stamp and stamp < int(inicio))


def _texto_clave(value) -> str:
    text = str(value or "").strip()
    if text.startswith("zoom:") and 14 <= len(text) <= 300:
        return text
    if re.fullmatch(r"yt:[A-Za-z0-9_-]{11}", text):
        return text
    return ""


def _id_youtube(value) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", text):
        return text
    return ""


def _unir_textos(previa, extra, cabe, tope: int) -> list[str]:
    clean: list[str] = []
    for item in list(previa or []) + list(extra or []):
        text = cabe(item)
        if not text or text in clean:
            continue
        clean.append(text)
    if len(clean) > tope:
        return clean[-tope:]
    return clean


def estado_mes(data) -> dict:
    base = data if isinstance(data, dict) else {}
    return {
        "mes": str(base.get("mes") or ""),
        "hecho": bool(base.get("hecho")),
        "ocupado": int(base.get("ocupado") or 0),
        "claves": _unir_textos(base.get("claves"), [], _texto_clave, 4000),
        "ids": _unir_textos(base.get("ids"), [], lambda item: item if _valid_id(str(item)) else "", 4000),
        "videos": _unir_textos(base.get("videos"), [], _id_youtube, 4000),
        "videoDia": str(base.get("videoDia") or ""),
        "permiso": bool(base.get("permiso")),
        "cursos": _unir_textos(base.get("cursos"), [], lambda item: _curso_id(str(item or "")), 500),
        "borradas": int(base.get("borradas") or 0),
        "cursosBorrados": int(base.get("cursosBorrados") or 0),
    }


def abrir_mes(estado: dict, corte: dict) -> dict:
    base = estado_mes(estado)
    if base["mes"] == corte.get("mes"):
        return base
    base["mes"] = str(corte.get("mes") or "")
    base["hecho"] = False
    base["ocupado"] = 0
    base["cursos"] = []
    base["borradas"] = 0
    base["cursosBorrados"] = 0
    return base


def cursos_huecos(tocados, filas) -> list[str]:
    quedan = set()
    for row in filas or []:
        if not isinstance(row, dict):
            continue
        curso = _curso_id(str(row.get("curso_id") or ""))
        if curso:
            quedan.add(curso)
    return [curso for curso in _unir_textos(tocados, [], lambda item: _curso_id(str(item or "")), 500) if curso not in quedan]


def quitar_orden(data, ids, cursos) -> dict:
    base = orden_limpio(data)
    quitados = {str(item) for item in ids or []}
    fuera = {str(item).lower() for item in cursos or []}
    salida = {}
    for key, valores in base.items():
        if str(key).lower() in fuera:
            continue
        resto = [item for item in valores if item not in quitados]
        if resto:
            salida[key] = resto
    return salida


def olvidada_de(claves, guardadas=None) -> dict | None:
    if guardadas is None:
        guardadas = set(leer_mes()["claves"])
    else:
        guardadas = {str(item) for item in guardadas}
    wanted = set(limpiar_fuentes(claves))
    if not wanted.intersection(guardadas):
        return None
    return {
        "id": "mes",
        "titulo": "el mes anterior",
        "tipo": "enlace",
        "estado": "lista",
        "creado": "",
    }


_MES_CACHE = {"en": 0.0, "data": None}


def _copiar_mes(data: dict) -> dict:
    return {
        "mes": data["mes"],
        "hecho": data["hecho"],
        "ocupado": data["ocupado"],
        "claves": list(data["claves"]),
        "ids": list(data["ids"]),
        "videos": list(data["videos"]),
        "videoDia": data["videoDia"],
        "permiso": data["permiso"],
        "cursos": list(data["cursos"]),
        "borradas": data["borradas"],
        "cursosBorrados": data["cursosBorrados"],
    }


def leer_mes() -> dict:
    ahora = time.time()
    if _MES_CACHE["data"] is not None and ahora - float(_MES_CACHE["en"]) < 30:
        return _copiar_mes(_MES_CACHE["data"])
    try:
        crudo = leer_ajuste("linkeo-mes.json")
    except Exception:
        crudo = None
    data = estado_mes(crudo)
    _MES_CACHE["en"] = ahora
    _MES_CACHE["data"] = data
    return _copiar_mes(data)


def guardar_mes(data: dict) -> None:
    limpio = estado_mes(data)
    guardar_ajuste("linkeo-mes.json", limpio)
    _MES_CACHE["en"] = time.time()
    _MES_CACHE["data"] = limpio


def mes_bloquea(class_id: str) -> bool:
    if not _valid_id(class_id):
        return False
    if class_id in leer_mes()["ids"]:
        return True
    corte = corte_mes(time.time())
    if not corte:
        return False
    stamp = epoch_de_id(class_id)
    return bool(stamp and stamp < corte["inicio"])


def _unir_estado(estado, claves=None, ids=None, cursos=None, videos=None) -> dict:
    actual = estado_mes(estado)
    actual["claves"] = _unir_textos(actual["claves"], claves, _texto_clave, 4000)
    actual["ids"] = _unir_textos(actual["ids"], ids, lambda item: item if _valid_id(str(item)) else "", 4000)
    actual["cursos"] = _unir_textos(actual["cursos"], cursos, lambda item: _curso_id(str(item or "")), 500)
    actual["videos"] = _unir_textos(actual["videos"], videos, _id_youtube, 4000)
    return actual


def _borrar_si_esta(method: str, path: str, body=None) -> None:
    try:
        _request(method, path, body, prefer="return=minimal")
    except engine.AppError as exc:
        if "404" in str(exc):
            return
        raise


def _carpeta_ocupada(folder: Path) -> bool:
    meta_path = folder / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if str(meta.get("status") or "") != "processing":
        return False
    try:
        edad = time.time() - meta_path.stat().st_mtime
    except OSError:
        return False
    return edad < 3600


def _claves_carpeta(folder: Path) -> list[str]:
    try:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(meta, dict):
        return []
    return [clave for clave in fuentes_de_meta(meta) if clave.startswith(("zoom:", "yt:"))]


def _borrar_carpeta(class_id: str) -> None:
    if not _valid_id(class_id):
        return
    folder = CLASSES / class_id
    if not folder.is_dir() or _carpeta_ocupada(folder):
        return
    import shutil
    shutil.rmtree(folder, ignore_errors=True)


def _ids_locales(corte, ids) -> list[str]:
    if not CLASSES.is_dir():
        return []
    salida = []
    marcados = set(ids or [])
    for folder in CLASSES.iterdir():
        class_id = folder.name
        if not _valid_id(class_id) or not (folder / "meta.json").is_file():
            continue
        if class_id in marcados:
            salida.append(class_id)
            continue
        stamp = epoch_de_id(class_id)
        if corte and stamp and stamp < corte["inicio"]:
            salida.append(class_id)
    return salida


def _olvidar_carpetas(corte, estado) -> dict:
    for class_id in _ids_locales(corte, estado["ids"]):
        folder = CLASSES / class_id
        claves = _claves_carpeta(folder)
        video = next((clave[3:] for clave in claves if clave.startswith("yt:") and len(clave) == 14), "")
        estado = _unir_estado(estado, claves=claves, ids=[class_id], videos=[video] if video else [])
        try:
            guardar_mes(estado)
        except engine.AppError:
            continue
        _borrar_carpeta(class_id)
    return leer_mes()


def _soltar_videos(estado, hoy: str) -> dict:
    if not estado["videos"] or estado.get("videoDia") == hoy:
        return estado
    import youtube_up
    quedan = []
    permiso = False
    for video in estado["videos"]:
        if permiso:
            quedan.append(video)
            continue
        resultado = youtube_up.borrar_video(video)
        if resultado == "borrado":
            continue
        quedan.append(video)
        if resultado == "permiso":
            permiso = True
    estado = dict(estado)
    estado["videos"] = quedan
    estado["videoDia"] = hoy
    estado["permiso"] = permiso or bool(quedan and estado.get("permiso"))
    guardar_mes(estado)
    return leer_mes()


def _borrar_remota(row, estado, marca) -> dict:
    class_id = str(row.get("id") or "")
    claves = [clave for clave in claves_de_fila(row) if clave.startswith(("zoom:", "yt:"))]
    video = next((clave[3:] for clave in claves if clave.startswith("yt:") and len(clave) == 14), "")
    curso = _curso_id(str(row.get("curso_id") or ""))
    estado = _unir_estado(
        estado,
        claves=claves,
        ids=[class_id],
        cursos=[curso] if curso else [],
        videos=[video] if video else [],
    )
    guardar_mes(estado)
    if video and not marca["permiso"]:
        import youtube_up
        resultado = youtube_up.borrar_video(video)
        if resultado == "borrado":
            estado["videos"] = [item for item in estado["videos"] if item != video]
        elif resultado == "permiso":
            marca["permiso"] = True
            estado["permiso"] = True
    _borrar_si_esta("DELETE", f"/rest/v1/diapositivas?clase_id=eq.{urllib.parse.quote(class_id)}")
    _borrar_si_esta("DELETE", "/storage/v1/object/diapositivas", {"prefixes": [class_id]})
    _borrar_si_esta("DELETE", f"/rest/v1/clases?id=eq.{urllib.parse.quote(class_id)}")
    _borrar_carpeta(class_id)
    estado["borradas"] = int(estado["borradas"] or 0) + 1
    guardar_mes(estado)
    return leer_mes()


def _cerrar_orden(estado, filas) -> tuple[dict, int]:
    huecos = cursos_huecos(estado["cursos"], filas)
    borrados = 0
    for curso in huecos:
        _borrar_si_esta("DELETE", f"/rest/v1/cursos?id=eq.{curso}")
        borrados += 1
    orden = leer_orden()
    limpio = quitar_orden(orden, estado["ids"], huecos)
    if limpio != orden:
        _request(
            "POST",
            "/storage/v1/object/diapositivas/" + urllib.parse.quote("ajustes/orden.json", safe="/"),
            json.dumps(limpio, ensure_ascii=False).encode("utf-8"),
            content_type="application/octet-stream",
            extra={"x-upsert": "true"},
        )
    return estado, borrados


def olvidar_mes() -> str:
    """Borra en la nube y en esta PC lo subido antes del mes en curso, desde el día 5."""
    if not configured():
        return "nada"
    corte = corte_mes(time.time())
    estado = leer_mes()
    if corte is None:
        _olvidar_carpetas(None, estado)
        return "espera"
    estado = abrir_mes(estado, corte)
    hoy = f"{corte['mes']}-{int(corte['dia']):02d}"
    if estado["hecho"] and estado["mes"] == corte["mes"]:
        estado = _olvidar_carpetas(corte, estado)
        if estado["videos"] and estado["videoDia"] != hoy:
            _soltar_videos(estado, hoy)
        return "hecho"
    ahora = int(time.time())
    if estado["ocupado"] and ahora - int(estado["ocupado"] or 0) < 20 * 60:
        return "ocupa"
    estado["ocupado"] = ahora
    estado["hecho"] = False
    try:
        guardar_mes(estado)
        marca = {"permiso": False}
        for _ronda in range(8):
            filas = _request(
                "GET",
                "/rest/v1/clases?select=id,video_url,estudio,curso_id,creado&limit=1000",
            )
            if not isinstance(filas, list):
                filas = []
            vencidas = [row for row in filas if clase_vencida(row, corte["inicio"])]
            if not vencidas:
                estado, borrados = _cerrar_orden(leer_mes(), filas)
                estado["hecho"] = True
                estado["ocupado"] = 0
                estado["cursosBorrados"] = int(estado["cursosBorrados"] or 0) + borrados
                if estado["videos"]:
                    estado["videoDia"] = hoy
                guardar_mes(estado)
                if estado["videos"]:
                    estado = _soltar_videos(leer_mes(), hoy)
                estado = _olvidar_carpetas(corte, leer_mes())
                if estado["borradas"] or estado["cursosBorrados"] or estado["videos"]:
                    print(
                        f"[ClaseClara] mes {corte['mes']}: {estado['borradas']} clases, "
                        f"{estado['cursosBorrados']} cursos, {len(estado['videos'])} videos pendientes",
                        flush=True,
                    )
                return "hecho"
            for row in vencidas[:25]:
                estado = _borrar_remota(row, leer_mes(), marca)
        estado = leer_mes()
        estado["ocupado"] = 0
        guardar_mes(estado)
        return "sigo"
    except engine.AppError:
        try:
            actual = leer_mes()
            actual["ocupado"] = 0
            guardar_mes(actual)
        except engine.AppError:
            pass
        return "falla"


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
    assert presentaciones_limpias([
        {"nombre": "  Bases.pptx  ", "url": "https://uvcv.edu.pe/pluginfile.php/1/Bases.pptx"},
        {"nombre": "Otra", "url": "https://uvcv.edu.pe/pluginfile.php/1/Bases.pptx"},
        {"nombre": "Zoom", "url": "https://zoom.us/rec/play/abcTOKEN1.pptx"},
        {"nombre": "Insegura", "url": "http://uvcv.edu.pe/a.pptx"},
    ]) == [{"nombre": "Bases.pptx", "url": "https://uvcv.edu.pe/pluginfile.php/1/Bases.pptx"}]
    assert presentaciones_limpias("no") == []
    assert lecturas_limpias([
        {
            "nombre": "Lectura 4.pdf",
            "url": "https://uvcv.edu.pe/webservice/pluginfile.php/99/mod_resource/content/1/lectura.pdf?token=secreto",
        },
        {"nombre": "Guía de lectura", "url": "https://ejemplo.com/guia"},
        {"nombre": "Bases.pptx", "url": "https://uvcv.edu.pe/pluginfile.php/1/Bases.pptx"},
        {"nombre": "Zoom", "url": "https://zoom.us/j/123"},
    ]) == [
        {
            "nombre": "Lectura 4.pdf",
            "url": "https://uvcv.edu.pe/pluginfile.php/99/mod_resource/content/1/lectura.pdf",
        },
        {"nombre": "Guía de lectura", "url": "https://ejemplo.com/guia"},
    ]
    assert profesor_limpio("  Ana   Pérez ") == "Ana Pérez"
    assert profesor_limpio("Sin profesor visible") == ""
    assert profesor_limpio("") == ""
    assert profesor_de_fuentes({"profesor": ""}, {"profesor": "Sin profesor visible"}, {"profesor": "Ana Pérez"}) == "Ana Pérez"
    assert profesor_de_fuentes({"profesor": "Luis Gómez"}, {"profesor": "Ana Pérez"}, {}) == "Luis Gómez"
    assert indice_portada("Sesión 5 · Sistema nervioso autónomo", [
        {"indice": 1, "que_muestra": "Pantalla con el nombre del profesor"},
        {"indice": 2, "que_muestra": "Título: Sistema Nervioso Autónomo"},
    ]) == 2
    assert indice_portada("Sesión 13 · Bases biológicas de las praxias", [
        {"indice": 1, "que_muestra": "Pantalla del profesor"},
        {"indice": 3, "que_muestra": "Diagramas de la praxia"},
    ]) == 3
    assert indice_portada("Educación en salud", [
        {"indice": 2, "que_muestra": "Profesor explicando modelos de educación para la salud"},
    ]) == 2
    assert indice_portada("Sesión 5 · Retroalimentación. Primer avance", [
        {"indice": 1, "que_muestra": "Profesor en videoconferencia, primer plano"},
    ]) == 0
    assert indice_portada("Asesoría personalizada", [
        {"indice": 1, "que_muestra": "Profesor solo en pantalla"},
        {"indice": 7, "que_muestra": "Pantalla con un formulario"},
    ]) == 0
    assert indice_portada("", [{"indice": 1, "que_muestra": "Sistema nervioso"}]) == 0
    assert _fila_ligera({"estudio_profesor": "  Ana   Pérez "})["estudio"]["profesor"] == "Ana Pérez"
    assert _fila_ligera({"estudio_profesor": "Sin profesor visible"})["estudio"]["profesor"] == ""
    assert elegir_titulo("Archivo", False, 0, "Del modelo", "Archivo", False, 0) == ("Del modelo", False, 0)
    assert elegir_titulo("Mio", True, 10, "Auto", "", True, 30) == ("Mio", True, 10)
    assert _titulo_remoto({"titulo": "En la tarjeta", "estudio": {"titulo": "Del modelo"}}) == ("En la tarjeta", True, 0)
    assert _titulo_remoto({
        "titulo": "Viejo",
        "estudio": {"titulo": "Nuevo", "titulo_custom": True, "titulo_en": 40},
    }) == ("Nuevo", True, 40)
    local = {
        "title": "Local",
        "title_custom": False,
        "fecha": "2026-01-01",
        "fecha_custom": False,
        "hora": "",
        "curso_id": "",
        "presentaciones": [{"nombre": "Local", "url": "https://uvcv.edu.pe/a.pptx"}],
        "youtube_url": "",
    }
    curso = "11111111-1111-1111-1111-111111111111"
    remote = {
        "titulo": "Remoto",
        "curso_id": curso,
        "video_url": "https://youtu.be/dQw4w9WgXcQ",
        "estudio": {
            "titulo": "Remoto",
            "titulo_custom": True,
            "titulo_en": 50,
            "fecha_clase": "2026-02-02",
            "fecha_custom": True,
            "hora_clase": "08:30",
            "presentaciones": [{"nombre": "Nube", "url": "https://uvcv.edu.pe/b.pptx"}],
        },
    }
    cambios = cambios_de_remoto(local, remote, "Del modelo")
    assert cambios["title"] == "Remoto" and cambios["title_custom"] is True and cambios["titulo_en"] == 50
    assert cambios["fecha"] == "2026-02-02" and cambios["fecha_custom"] is True
    assert cambios["hora"] == "08:30"
    assert cambios["curso_id"] == curso
    assert cambios["youtube_url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert [item["url"] for item in cambios["presentaciones"]] == [
        "https://uvcv.edu.pe/a.pptx",
        "https://uvcv.edu.pe/b.pptx",
    ]
    assert unir_presentaciones(local["presentaciones"], []) == [
        {"nombre": "Local", "url": "https://uvcv.edu.pe/a.pptx"},
    ]
    propia = dict(local)
    propia.update({
        "title": "Mio",
        "title_custom": True,
        "titulo_en": 80,
        "fecha": "2026-03-03",
        "fecha_custom": True,
        "hora": "09:00",
        "curso_id": curso,
        "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "presentaciones": [
            {"nombre": "Local", "url": "https://uvcv.edu.pe/a.pptx"},
            {"nombre": "Nube", "url": "https://uvcv.edu.pe/b.pptx"},
        ],
    })
    assert cambios_de_remoto(propia, remote, "") == {}
    bases_id = "7e0217b2-ae79-48e2-b2f1-a507c273aa91"
    creatividad_id = "2fd013dc-1362-4115-a326-d5c0135452a9"
    catalogo = [
        {
            "id": bases_id,
            "nombre": "202602 - E-V02 - LIMA NORTE - PSICOLOGÍA - BASES BIOLOGICAS DEL COMPORTAMIENTO",
        },
        {
            "id": creatividad_id,
            "nombre": "202602 - E-V02 - LIMA NORTE - PSICOLOGÍA - CREATIVIDAD E INNOVACION - B9",
        },
    ]
    assert nombre_clave("  A   B ") == "a b"
    assert curso_id_por_nombre(catalogo[0]["nombre"], catalogo) == bases_id
    assert curso_id_por_nombre("Estadística", catalogo) == ""
    assert elegir_curso_id(creatividad_id, creatividad_id, bases_id) == bases_id
    assert elegir_curso_id("", creatividad_id, "") == creatividad_id
    assert elegir_curso_id(bases_id, "", "") == bases_id
    assert elegir_curso_id("no", "no", "no") == ""
    sin_fijo = {
        "materia": catalogo[0]["nombre"],
        "curso_id": bases_id,
    }
    lejos = {"curso_id": creatividad_id, "estudio": {}}
    assert cambios_de_remoto(sin_fijo, lejos, "").get("curso_id") == creatividad_id
    guardado_cursos = list_cursos
    globals()["list_cursos"] = lambda: catalogo
    try:
        mal = {
            "materia": catalogo[0]["nombre"],
            "materia_custom": True,
            "curso_id": creatividad_id,
        }
        assert cambios_de_remoto(mal, lejos, "").get("curso_id") == bases_id
        bien = dict(mal)
        bien["curso_id"] = bases_id
        assert "curso_id" not in cambios_de_remoto(bien, lejos, "")
        corta = {"materia": "Estadística", "materia_custom": True, "curso_id": ""}
        assert cambios_de_remoto(corta, lejos, "").get("curso_id") == creatividad_id
    finally:
        globals()["list_cursos"] = guardado_cursos
    assert orden_limpio({
        "curso": ["20260101-120000-abcdef", "no", "20260101-120000-abcdef", "20260101-120001-abcdef"],
        "": ["20260101-120000-abcdef"],
        "otro": "no-lista",
    }) == {"curso": ["20260101-120000-abcdef", "20260101-120001-abcdef"]}
    assert es_de_esta_pc({"universidad": "", "carrera": ""})
    assert es_de_esta_pc({"universidad": PC_UNIVERSIDAD, "carrera": PC_CARRERA})
    assert not es_de_esta_pc({"universidad": "Otra", "carrera": PC_CARRERA})
    assert not es_de_esta_pc({"universidad": PC_UNIVERSIDAD, "carrera": "Otra"})
    assert not es_de_esta_pc("no")
    base = "https://ucv-edu-pe.zoom.us/"
    share = base + "rec/share/tokenShare"
    play = base + "rec/play/tokenPlay"
    html_share = '<html><script>window.__data__ = {"meetingId":"meet-1"};</script></html>'
    html_play = '<html><script>window.__data__ = {"fileId":"file-1"};</script></html>'
    rutas = {
        share: html_share,
        base + "nws/recording/1.0/play/share-info/meet-1": {
            "result": {"redirectUrl": "/rec/play/tokenPlay"},
        },
        play: html_play,
        base + "nws/recording/1.0/play/info/file-1?continueMode=true": {
            "result": {
                "shareMp4Url": "https://file.zoom.us/pantalla.mp4",
                "viewMp4Url": "https://file.zoom.us/camara.mp4",
                "viewMp4WithshareUrl": "https://file.zoom.us/juntos.mp4",
            },
        },
    }
    assert _resolver_grabacion(share, lambda url: rutas[url]) == "https://file.zoom.us/juntos.mp4"
    assert _elegir_mp4({
        "result": {
            "viewMp4WithshareUrl": "http://file.zoom.us/juntos.mp4",
            "viewMp4Url": "https://file.zoom.us/camara.mp4",
        },
    }, base) == "https://file.zoom.us/camara.mp4"
    assert _elegir_mp4({"result": {"viewMp4Url": "https://127.0.0.1/a.mp4"}}, base) == ""
    assert _elegir_mp4({"result": {"viewMp4Url": "https://10.1.2.3/a.mp4"}}, base) == ""
    assert _elegir_mp4({"result": {"viewMp4Url": "https://user:secret@file.zoom.us/a.mp4"}}, base) == ""
    assert _elegir_mp4({"result": {"viewMp4Url": "/archivo.mp4"}}, base) == base + "archivo.mp4"
    assert _resolver_grabacion(play, lambda url: {
        play: html_play,
        base + "nws/recording/1.0/play/info/file-1": {
            "result": {"viewMp4Url": "https://file.zoom.us/camara.mp4"},
        },
    }[url]) == "https://file.zoom.us/camara.mp4"
    anidado = '<html><script>window.__data__ = {"recording":{"fileId":"file-2"}};</script></html>'
    assert _resolver_grabacion(play, lambda url: {
        play: anidado,
        base + "nws/recording/1.0/play/info/file-2": {
            "result": {"viewMp4Url": "https://ssrweb.zoom.us/v.mp4"},
        },
    }[url]) == "https://ssrweb.zoom.us/v.mp4"
    comillas = "<html><script>window.__data__ = {fileId:'file-4'};</script></html>"
    assert _resolver_grabacion(play, lambda url: {
        play: comillas,
        base + "nws/recording/1.0/play/info/file-4": {
            "result": {"shareMp4Url": "https://file.zoom.us/pantalla.mp4"},
        },
    }[url]) == "https://file.zoom.us/pantalla.mp4"
    parseado = (
        '<html><script>window.__data__ = JSON.parse("'
        + r'{\"fileId\":\"file-3\"}'
        + '");</script></html>'
    )
    assert _datos_reproductor(parseado)["fileId"] == "file-3"
    vistos = []

    def pedir_clave(url):
        vistos.append(url)
        return '<html><form id="password_form" method="post"></form></html>'

    try:
        _resolver_grabacion(play, pedir_clave)
    except engine.AppError as exc:
        assert str(exc) == _MSG_CLAVE
    else:
        raise AssertionError("debio avisar la clave corta")
    assert vistos == [play]
    plantilla = (
        '<html><script>var t = \'<form id="password_form"></form>\';</script>'
        '<script>window.__data__ = {"fileId":"file-1"};</script></html>'
    )
    assert not _pide_clave_zoom(plantilla)
    assert _resolver_grabacion(play, lambda url: {
        play: plantilla,
        base + "nws/recording/1.0/play/info/file-1": {
            "result": {"viewMp4Url": "https://file.zoom.us/camara.mp4"},
        },
    }[url]) == "https://file.zoom.us/camara.mp4"
    con_clave = (
        '<html><form class="x" id="password_form"></form>'
        '<script>window.__data__ = {"fileId":"file-1"};</script></html>'
    )
    assert _pide_clave_zoom(con_clave)
    down = base + "rec/download/tokenPlay?pwd=1"
    play_q = base + "rec/play/tokenPlay?pwd=1"
    assert _resolver_grabacion(down, lambda url: {
        play_q: html_play,
        base + "nws/recording/1.0/play/info/file-1": {
            "result": {"viewMp4Url": "https://file.zoom.us/camara.mp4"},
        },
    }[url]) == "https://file.zoom.us/camara.mp4"
    assert _respuesta_pagina("text/html; charset=utf-8", b"<html></html>")
    assert not _respuesta_pagina("video/mp4", b"\x00\x00\x00\x18ftypmp42")
    assert _respuesta_pagina("application/octet-stream", b"<!DOCTYPE html>")
    assert _respuesta_pagina("video/mp4", b"{")

    class _Cabeceras(dict):
        def get_content_charset(self, failobj=None):
            return "utf-8"

    class _Respuesta:
        def __init__(self, kind: str, body: bytes):
            self.headers = _Cabeceras({"Content-Type": kind})
            self._body = body
            self._pos = 0

        def read(self, size: int = -1) -> bytes:
            if self._pos >= len(self._body):
                return b""
            if size is None or size < 0:
                size = len(self._body) - self._pos
            chunk = self._body[self._pos:self._pos + size]
            self._pos += len(chunk)
            return chunk

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class _Router:
        def __init__(self, mapa):
            self.mapa = mapa
            self.urls = []

        def open(self, request, timeout=60):
            url = request.full_url
            self.urls.append(url)
            if "validate" in url or "passwd" in url:
                raise AssertionError("no hay que mandar clave")
            if url not in self.mapa:
                raise AssertionError(url)
            kind, body = self.mapa[url]
            return _Respuesta(kind, body)

    import tempfile
    video = b"\x00\x00\x00\x18ftypmp42" + (b"v" * 120_000)
    pagina = plantilla.encode("utf-8")
    info = json.dumps({
        "result": {
            "viewMp4WithshareUrl": "https://file.zoom.us/juntos.mp4",
            "viewMp4Url": "https://file.zoom.us/camara.mp4",
        },
    }).encode("utf-8")
    sample = "https://ucv-edu-pe.zoom.us/rec/play/tokenPlay"
    target = playback_url(sample)
    with tempfile.TemporaryDirectory() as folder:
        dest = Path(folder) / "v.mp4"
        directo = _Router({target: ("video/mp4", video)})
        _bajar_zoom(sample, dest, directo)
        assert directo.urls == [target]
        assert dest.read_bytes() == video
        dest.unlink()
        router = _Router({
            target: ("text/html; charset=utf-8", pagina),
            sample: ("text/html", pagina),
            base + "nws/recording/1.0/play/info/file-1": ("application/json", info),
            "https://file.zoom.us/juntos.mp4": ("video/mp4", video),
        })
        _bajar_zoom(sample, dest, router)
        assert router.urls == [
            target,
            sample,
            base + "nws/recording/1.0/play/info/file-1",
            "https://file.zoom.us/juntos.mp4",
        ]
        assert dest.read_bytes() == video
        dest.unlink()
        clave = '<html><form name="password_form"></form></html>'.encode("utf-8")
        bloqueado = _Router({
            target: ("text/html", clave),
            sample: ("text/html", clave),
        })
        try:
            _bajar_zoom(sample, dest, bloqueado)
        except engine.AppError as exc:
            assert str(exc) == _MSG_CLAVE
        else:
            raise AssertionError("debio avisar la clave corta")
        assert not dest.exists()
        assert bloqueado.urls == [target, sample]
    nov4 = datetime(2026, 11, 5, 4, 59, tzinfo=timezone.utc).timestamp()
    nov5 = datetime(2026, 11, 5, 5, tzinfo=timezone.utc).timestamp()
    assert dia_lima(nov4) == "2026-11-04"
    assert dia_lima(nov5) == "2026-11-05"
    assert corte_mes(nov4) is None
    corte = corte_mes(nov5)
    assert corte and corte["mes"] == "2026-11"
    assert corte["inicio"] == int(datetime(2026, 11, 1, 5, tzinfo=timezone.utc).timestamp())
    octubre = {"id": "20261031-230000-abcdef", "creado": "2026-11-01T04:00:00+00:00"}
    noviembre = {"id": "20261101-235757-67e37c", "creado": "2026-11-02T04:59:41+00:00"}
    assert clase_vencida(octubre, corte["inicio"])
    assert not clase_vencida(noviembre, corte["inicio"])
    assert epoch_de_id("20261031-235959-abcdef") < corte["inicio"]
    assert epoch_de_id("20261101-000000-abcdef") == corte["inicio"]
    assert not clase_vencida({"id": "20261101-000000-abcdef", "creado": ""}, corte["inicio"])
    diciembre = corte_mes(datetime(2026, 12, 5, 5, tzinfo=timezone.utc).timestamp())
    assert diciembre and diciembre["mes"] == "2026-12"
    assert clase_vencida({"id": "20261130-235959-abcdef", "creado": "2026-12-01T04:59:59+00:00"}, diciembre["inicio"])
    assert not clase_vencida({"id": "20261201-000000-abcdef", "creado": "2026-12-01T05:00:00+00:00"}, diciembre["inicio"])
    assert corte_mes(datetime(2027, 1, 5, 5, tzinfo=timezone.utc).timestamp())["mes"] == "2027-01"
    sigue = "7e0217b2-ae79-48e2-b2f1-a507c273aa91"
    vacio = "2fd013dc-1362-4115-a326-d5c0135452a9"
    assert cursos_huecos([sigue, vacio], [{"curso_id": sigue}]) == [vacio]
    assert cursos_huecos([], [{"curso_id": vacio}]) == []
    orden = quitar_orden(
        {sigue: ["20261031-230000-abcdef", "20261102-120000-abcdef"], vacio: ["20261015-120000-abcdef"]},
        ["20261031-230000-abcdef", "20261015-120000-abcdef"],
        [vacio],
    )
    assert vacio not in orden and orden[sigue] == ["20261102-120000-abcdef"]
    abierto = abrir_mes({"mes": "2026-10", "hecho": True, "claves": ["yt:dQw4w9WgXcQ"]}, corte)
    assert abierto["hecho"] is False and abierto["claves"] == ["yt:dQw4w9WgXcQ"] and abierto["mes"] == "2026-11"
    assert abrir_mes(abierto, corte)["claves"] == ["yt:dQw4w9WgXcQ"]
    hallada = olvidada_de(
        ["zoom:ucv-edu-pe.zoom.us/tokenPlay12"],
        {"zoom:ucv-edu-pe.zoom.us/tokenPlay12"},
    )
    assert hallada and hallada["id"] == "mes" and hallada["tipo"] == "enlace"
    assert olvidada_de(["zoom:ucv-edu-pe.zoom.us/otraClave1"], {"zoom:ucv-edu-pe.zoom.us/tokenPlay12"}) is None
    assert "password" not in json.dumps(abierto) and "refresh" not in json.dumps(abierto)

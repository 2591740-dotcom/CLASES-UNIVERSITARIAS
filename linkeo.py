"""LINKEODECLASESCLARA: programa local que lee Clementina y agrega las clases a ClaseClara."""

from __future__ import annotations

import atexit
import json
import re
import socket
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import app
import cloud
import engine

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PAGINA = STATIC / "LINKEODECLASESCLARA.html"
TOPE = 500

LOCK = threading.Lock()
EN_CURSO = ""
LIMA = timezone(timedelta(hours=-5))
ESTADO = {
    "activo": False,
    "terminado": False,
    "total": 0,
    "hechas": 0,
    "ya": 0,
    "sin_video": 0,
    "futuras": 0,
    "anteriores": 0,
    "cursos": 0,
    "actual": "",
    "errores": [],
}
ULTIMA: dict = {}


def nombre_curso(nombre: str) -> str:
    text = " ".join(str(nombre or "").split())
    if len(text) <= 80:
        return text
    corto = text[:80].rstrip()
    espacio = corto.rfind(" ")
    if espacio >= 40:
        corto = corto[:espacio]
    return corto.rstrip(" .-")


def titulo_clase(sesion: dict) -> str:
    numero = str(sesion.get("numero") or "").strip()
    titulo = " ".join(str(sesion.get("titulo") or "").split())
    ya = bool(numero) and re.match(rf"(?i)^sesi[oó]n\s+0*{re.escape(numero)}\b", titulo or "")
    if numero and titulo and not ya:
        text = f"Sesión {numero} · {titulo}"
    elif titulo:
        text = titulo
    elif numero:
        text = f"Sesión {numero}"
    else:
        text = "Clase"
    return text[:140]


_MESES = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6,
    "julio": 7, "agosto": 8, "setiembre": 9, "septiembre": 9, "octubre": 10,
    "noviembre": 11, "diciembre": 12,
}


def es_asincronica(nombre: str) -> bool:
    return bool(re.search(r"asincr[oó]nic", str(nombre or ""), re.I))


def titulo_asincronico(titulo: str) -> str:
    text = " ".join(str(titulo or "").split())
    if es_asincronica(text):
        return text[:140]
    marca = re.match(r"(?i)^(sesi[oó]n\s+\d+)\s*·\s*(.*)$", text)
    if marca:
        text = f"{marca.group(1)} · Asincrónica · {marca.group(2)}"
    else:
        text = f"Asincrónica · {text}"
    return " ".join(text.split())[:140]


def cita_asincronica(nombre: str, anio: str = "") -> tuple[str, str]:
    """Día y hora escritos en el nombre de la videoconferencia asincrónica."""
    texto = " ".join(str(nombre or "").split())
    fecha = ""
    match = re.search(
        r"(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?",
        texto,
        re.I,
    )
    if match:
        year = int(match.group(3) or anio or 0)
        if 2000 <= year <= 2100:
            try:
                fecha = datetime(year, _MESES[match.group(2).casefold()], int(match.group(1))).date().isoformat()
            except ValueError:
                fecha = ""
    hora = ""
    reloj = re.search(r"(\d{1,2}):(\d{2})", texto)
    if reloj:
        hora = engine.hora_valida(f"{int(reloj.group(1)):02d}:{reloj.group(2)}")
    return fecha, hora


def hora_inicio(valor: str) -> str:
    match = re.match(r"(\d{1,2}):(\d{2})", str(valor or "").strip())
    if not match:
        return ""
    return engine.hora_valida(f"{int(match.group(1)):02d}:{match.group(2)}")


def zoom_rec(url: str) -> str:
    try:
        return cloud.assert_zoom_url(url)
    except engine.AppError:
        return ""


def ahora_lima() -> datetime:
    return datetime.now(LIMA)


def tiene_grabacion(sesion: dict) -> bool:
    enlaces = sesion.get("enlaces") if isinstance(sesion.get("enlaces"), list) else []
    return any(zoom_rec(str(item.get("url") or "")) for item in enlaces if isinstance(item, dict))


def fecha_cita(value: str) -> str:
    """Fecha de Clementina, también si todavía no llega. El motor de la clase no acepta una fecha lejana."""
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", str(value or "").strip())
    if not match:
        return ""
    year, month, day = (int(part) for part in match.groups())
    try:
        found = datetime(year, month, day)
    except ValueError:
        return ""
    if not 2000 <= found.year <= 2100:
        return ""
    return found.date().isoformat()


def es_futura(fecha: str, hora: str, ahora: datetime) -> bool:
    iso = fecha_cita(fecha)
    if not iso:
        return False
    clock = hora_inicio(hora)
    if not clock:
        return iso > ahora.date().isoformat()
    year, month, day = (int(part) for part in iso.split("-"))
    hour, minute = (int(part) for part in clock.split(":"))
    return datetime(year, month, day, hour, minute, tzinfo=LIMA) > ahora


def clasificar_sesion(sesion: dict, corte: str, ahora: datetime) -> str:
    """futura: aún no empieza y no hay grabación.

    El recorte desde la última clase guardada está apagado: cada apertura muestra todo.
    Si la grabación ya está, la sesión entra aunque la hora de empezar siga siendo futura.
    """
    del corte
    fecha = fecha_cita(str(sesion.get("fecha_iso") or ""))
    if es_futura(fecha, str(sesion.get("hora") or ""), ahora) and not tiene_grabacion(sesion):
        return "futura"
    return ""


def _anotar_fecha(acumulado: dict[str, list[str]], nombre: str, fecha: str) -> None:
    iso = engine.fecha_iso(str(fecha or ""))
    clave = nombre_curso(nombre).casefold()
    if iso and clave:
        acumulado.setdefault(clave, []).append(iso)


def fechas_guardadas(ahora: datetime | None = None) -> dict[str, str]:
    """Fecha más nueva ya guardada por curso. Una clase a futuro no adelanta ese límite."""
    hoy = (ahora or ahora_lima()).date().isoformat()
    nombres_por_id: dict[str, str] = {}
    try:
        for row in cloud.list_cursos():
            if not isinstance(row, dict):
                continue
            curso_id = str(row.get("id") or "")
            nombre = nombre_curso(row.get("nombre") or "")
            if curso_id and nombre:
                nombres_por_id[curso_id] = nombre
    except engine.AppError:
        nombres_por_id = {}
    acumulado: dict[str, list[str]] = {}

    def anotar(nombre: str, curso_id: str, fecha: str) -> None:
        titulo = nombre_curso(nombre) or nombres_por_id.get(curso_id, "")
        _anotar_fecha(acumulado, titulo, fecha)

    if app.CLASSES.is_dir():
        for folder in app.CLASSES.iterdir():
            meta_path = folder / "meta.json"
            if not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(meta, dict):
                continue
            anotar(str(meta.get("materia") or ""), str(meta.get("curso_id") or ""), str(meta.get("fecha") or ""))
    try:
        remotas = cloud.fechas_remotas()
    except engine.AppError:
        remotas = []
    for row in remotas:
        anotar(row.get("materia") or "", row.get("curso_id") or "", row.get("fecha") or "")
    salida = {}
    for clave, fechas in acumulado.items():
        pasadas = [iso for iso in fechas if iso <= hoy]
        if pasadas:
            salida[clave] = max(pasadas)
    return salida


def entradas_de(cursos, ahora: datetime | None = None, ultimas: dict | None = None) -> list[dict]:
    salida = []
    vistos = set()
    if not isinstance(cursos, list):
        return salida
    momento = ahora or ahora_lima()
    del ultimas
    for curso in cursos:
        if not isinstance(curso, dict):
            continue
        nombre = nombre_curso(curso.get("nombre") or "")
        if not nombre:
            continue
        corte = ""
        sesiones = curso.get("sesiones") if isinstance(curso.get("sesiones"), list) else []
        for sesion in sesiones:
            if not isinstance(sesion, dict):
                continue
            if clasificar_sesion(sesion, corte, momento):
                continue
            titulo = titulo_clase(sesion)
            fecha = fecha_cita(str(sesion.get("fecha_iso") or ""))
            hora = hora_inicio(str(sesion.get("hora") or ""))
            enlaces = sesion.get("enlaces") if isinstance(sesion.get("enlaces"), list) else []
            for enlace in enlaces:
                if not isinstance(enlace, dict):
                    continue
                url = zoom_rec(str(enlace.get("url") or ""))
                if not url or url in vistos:
                    continue
                vistos.add(url)
                nombre_enlace = str(enlace.get("nombre") or "")
                titulo_item = titulo
                fecha_item = fecha
                hora_item = hora
                if es_asincronica(nombre_enlace):
                    titulo_item = titulo_asincronico(titulo)
                    cita, inicio = cita_asincronica(nombre_enlace, fecha[:4] if fecha else "")
                    if cita:
                        fecha_item = cita
                    if inicio:
                        hora_item = inicio
                salida.append({
                    "curso": nombre,
                    "titulo": titulo_item,
                    "fecha": fecha_item,
                    "hora": hora_item,
                    "url": url,
                    "profesor": cloud.profesor_limpio(curso.get("profesor")),
                    "presentaciones": cloud.presentaciones_limpias(sesion.get("presentaciones")),
                    "lecturas": lecturas_de_sesion(sesion),
                })
    return salida


def lecturas_de_sesion(sesion: dict) -> list[dict]:
    """Documentos de esta sesión que no son la grabación ni la presentación."""
    enlaces = sesion.get("enlaces") if isinstance(sesion.get("enlaces"), list) else []
    crudas = []
    for enlace in enlaces:
        if not isinstance(enlace, dict):
            continue
        url = str(enlace.get("url") or "")
        if zoom_rec(url):
            continue
        crudas.append(enlace)
    return cloud.lecturas_limpias(crudas)


def sesiones_con_presentacion(cursos) -> list[dict]:
    """Cada grabación con el profesor, la hora y los archivos de su sesión."""
    salida = []
    vistos = set()
    if not isinstance(cursos, list):
        return salida
    for curso in cursos:
        if not isinstance(curso, dict):
            continue
        profesor = cloud.profesor_limpio(curso.get("profesor"))
        sesiones = curso.get("sesiones") if isinstance(curso.get("sesiones"), list) else []
        for sesion in sesiones:
            if not isinstance(sesion, dict):
                continue
            archivos = cloud.presentaciones_limpias(sesion.get("presentaciones"))
            docs = lecturas_de_sesion(sesion)
            fecha = fecha_cita(str(sesion.get("fecha_iso") or ""))
            hora = hora_inicio(str(sesion.get("hora") or ""))
            if not archivos and not docs and not profesor and not engine.fecha_iso(fecha) and not hora:
                continue
            enlaces = sesion.get("enlaces") if isinstance(sesion.get("enlaces"), list) else []
            for enlace in enlaces:
                if not isinstance(enlace, dict):
                    continue
                url = zoom_rec(str(enlace.get("url") or ""))
                if not url or url in vistos:
                    continue
                vistos.add(url)
                salida.append({
                    "url": url,
                    "presentaciones": archivos,
                    "lecturas": docs,
                    "profesor": profesor,
                    "fecha": fecha,
                    "hora": hora,
                })
    return salida


def anotar_presentaciones(
    class_id: str,
    items,
    lecturas=None,
    profesor: str = "",
    fecha: str = "",
    hora: str = "",
) -> bool:
    """Guarda en la clase lo que ya estaba y lo nuevo. No vuelve a bajar el video."""
    ppt = cloud.presentaciones_limpias(items)
    docs = cloud.lecturas_limpias(lecturas)
    nombre = cloud.profesor_limpio(profesor)
    cita = engine.fecha_iso(fecha)
    inicio = engine.hora_valida(hora)
    if not class_id or not (ppt or docs or nombre or cita or inicio):
        return False
    cambios: dict = {}
    if ppt:
        cambios["presentaciones"] = ppt
    if docs:
        cambios["lecturas"] = docs
    if nombre:
        cambios["profesor"] = nombre
    if cita:
        cambios["fecha"] = cita
        cambios["fecha_origen"] = "clementina"
        cambios["fecha_custom"] = True
    if inicio:
        cambios["hora"] = inicio
    try:
        app.update_meta(class_id, **cambios)
    except engine.AppError:
        return False
    try:
        folder = app.class_dir(class_id)
        study_path = folder / "study.json"
        study = app.read_json(study_path, None)
        if isinstance(study, dict):
            if ppt:
                study["presentaciones"] = ppt
            if docs:
                study["lecturas"] = docs
            if nombre:
                study["profesor"] = nombre
            if cita:
                study["fecha_clase"] = cita
            if inicio:
                study["hora_clase"] = inicio
            study_path.write_text(json.dumps(study, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, engine.AppError):
        traceback.print_exc()
    return True


def pegar_presentaciones(cursos) -> int:
    filas = app.filas_locales()
    try:
        filas.extend(cloud.filas_fuentes())
    except engine.AppError:
        pass
    hechos = 0
    vistos = set()
    for item in sesiones_con_presentacion(cursos):
        found = cloud.fila_duplicada(filas, cloud.fuentes_de_url(item["url"]))
        class_id = str((found or {}).get("id") or "")
        if not class_id or class_id in vistos:
            continue
        vistos.add(class_id)
        if anotar_presentaciones(
            class_id,
            item.get("presentaciones") or [],
            item.get("lecturas") or [],
            item.get("profesor") or "",
            item.get("fecha") or "",
            item.get("hora") or "",
        ):
            hechos += 1
    return hechos


def contar_sesiones(cursos, ahora: datetime | None = None, ultimas: dict | None = None) -> dict:
    totales = {"sin_video": 0, "futuras": 0, "anteriores": 0}
    if not isinstance(cursos, list):
        return totales
    momento = ahora or ahora_lima()
    del ultimas
    for curso in cursos:
        if not isinstance(curso, dict):
            continue
        corte = ""
        sesiones = curso.get("sesiones") if isinstance(curso.get("sesiones"), list) else []
        for sesion in sesiones:
            if not isinstance(sesion, dict):
                continue
            motivo = clasificar_sesion(sesion, corte, momento)
            if motivo == "futura":
                totales["futuras"] += 1
            elif motivo:
                totales["anteriores"] += 1
            elif not tiene_grabacion(sesion):
                totales["sin_video"] += 1
    return totales


def anotar_cursos(data: dict, ahora: datetime | None = None, ultimas: dict | None = None) -> dict:
    if not isinstance(data, dict):
        return data
    cursos = data.get("cursos")
    if not isinstance(cursos, list):
        return data
    momento = ahora or ahora_lima()
    del ultimas
    for curso in cursos:
        if not isinstance(curso, dict):
            continue
        corte = ""
        curso["desde"] = corte
        sesiones = curso.get("sesiones") if isinstance(curso.get("sesiones"), list) else []
        for sesion in sesiones:
            if not isinstance(sesion, dict):
                continue
            motivo = clasificar_sesion(sesion, corte, momento)
            sesion["motivo"] = motivo
            sesion["agregar"] = motivo == "" and tiene_grabacion(sesion)
    return data


def cursos_nombrados(cursos) -> list[str]:
    nombres = []
    vistos = set()
    if not isinstance(cursos, list):
        return nombres
    for curso in cursos[:40]:
        if not isinstance(curso, dict):
            continue
        nombre = nombre_curso(curso.get("nombre") or "")
        clave = nombre.casefold()
        if not nombre or clave in vistos:
            continue
        vistos.add(clave)
        nombres.append(nombre)
    return nombres


def asegurar_curso(nombre: str) -> dict:
    limpio = nombre_curso(nombre)
    if not limpio:
        raise engine.AppError("El curso no tiene nombre.")

    def buscar() -> dict | None:
        for row in cloud.list_cursos():
            if not isinstance(row, dict):
                continue
            otro = nombre_curso(row.get("nombre") or "")
            if otro.casefold() == limpio.casefold():
                return row
        return None

    hallado = buscar()
    if hallado:
        return hallado
    try:
        return cloud.crear_curso(limpio)
    except engine.AppError:
        hallado = buscar()
        if hallado:
            return hallado
        raise


def _al_cerrar() -> None:
    class_id = EN_CURSO
    if not class_id:
        return
    try:
        meta = app.read_meta(class_id)
        if meta.get("status") != "processing":
            return
        app.update_meta(
            class_id,
            status="error",
            stage="error",
            detail="",
            error="Se cerró LINKEODECLASESCLARA antes de terminar. Ábrelo otra vez y vuelve a agregar, o pulsa Reintentar en ClaseClara.",
        )
    except Exception:
        return


atexit.register(_al_cerrar)


def foto() -> dict:
    with LOCK:
        return json.loads(json.dumps(ESTADO))


def _anotar_error(curso: str, titulo: str, message: str) -> None:
    with LOCK:
        if len(ESTADO["errores"]) >= 40:
            return
        ESTADO["errores"].append({
            "curso": curso,
            "titulo": titulo,
            "error": (message or "No pude preparar esa clase.").strip()[:180],
        })


def esperar_clase(class_id: str) -> dict:
    limite = time.time() + 6 * 60 * 60
    while time.time() < limite:
        try:
            meta = app.read_meta(class_id)
        except engine.AppError:
            time.sleep(4)
            continue
        estado = str(meta.get("status") or "")
        with app.YOUTUBE_LOCK:
            subiendo = class_id in app.YOUTUBE_UPLOADS
        if estado in {"ready", "error"} and not subiendo and class_id not in app.ACTIVE:
            return meta
        time.sleep(4)
    return {"status": "error", "error": "Esta clase tardó demasiado."}


def _trabajar(cursos: list) -> None:
    global EN_CURSO
    try:
        nombres = cursos_nombrados(cursos)
        momento = ahora_lima()
        ultimas = {}
        entradas = entradas_de(cursos, ahora=momento, ultimas=ultimas)
        conteo = contar_sesiones(cursos, ahora=momento, ultimas=ultimas)
        recortadas = 0
        if len(entradas) > TOPE:
            recortadas = len(entradas) - TOPE
            entradas = entradas[:TOPE]
        with LOCK:
            ESTADO["total"] = len(entradas)
            ESTADO["sin_video"] = conteo["sin_video"]
            ESTADO["futuras"] = conteo["futuras"]
            ESTADO["anteriores"] = conteo["anteriores"]
        ids: dict[str, str] = {}
        for nombre in nombres:
            try:
                row = asegurar_curso(nombre)
                ids[nombre.casefold()] = str(row.get("id") or "")
                with LOCK:
                    ESTADO["cursos"] += 1
                print(f"[LINKEO] curso listo: {nombre}", flush=True)
            except engine.AppError as exc:
                _anotar_error(nombre, "", str(exc))
                print(f"[LINKEO] no pude crear el curso {nombre}: {exc}", flush=True)
        if recortadas:
            _anotar_error("", "", f"Quedaron {recortadas} grabaciones para otra pasada.")
        try:
            pegadas = pegar_presentaciones(cursos)
            if pegadas:
                print(f"[LINKEO] presentaciones en {pegadas} clases", flush=True)
        except Exception:
            traceback.print_exc()
        for item in entradas:
            with LOCK:
                ESTADO["actual"] = item["titulo"]
            curso_id = cloud.curso_id_por_nombre(item["curso"]) or ids.get(item["curso"].casefold(), "")
            if not curso_id:
                _anotar_error(item["curso"], item["titulo"], "No pude crear el curso, así que no procesé esta grabación.")
                continue
            print(f"[LINKEO] empieza {item['titulo']}", flush=True)
            try:
                class_id = app.create_class_from_url(
                    item["url"],
                    item["curso"],
                    "",
                    curso_id,
                    titulo=item["titulo"],
                    fecha=item["fecha"],
                    hora=item["hora"],
                    fijar_materia=True,
                    desde_clementina=True,
                    presentaciones=item.get("presentaciones") or [],
                    lecturas=item.get("lecturas") or [],
                    profesor=item.get("profesor") or "",
                )
                EN_CURSO = class_id
            except app.DuplicateClass as exc:
                anotar_presentaciones(
                    exc.class_id,
                    item.get("presentaciones") or [],
                    item.get("lecturas") or [],
                    item.get("profesor") or "",
                    item.get("fecha") or "",
                    item.get("hora") or "",
                )
                with LOCK:
                    ESTADO["ya"] += 1
                print(f"[LINKEO] ya estaba {item['titulo']}", flush=True)
                continue
            except engine.AppError as exc:
                _anotar_error(item["curso"], item["titulo"], str(exc))
                print(f"[LINKEO] error {item['titulo']}: {exc}", flush=True)
                continue
            except Exception as exc:
                traceback.print_exc()
                _anotar_error(item["curso"], item["titulo"], str(exc) or "No pude preparar esa clase.")
                continue
            meta = esperar_clase(class_id)
            EN_CURSO = ""
            if meta.get("status") == "ready":
                with LOCK:
                    ESTADO["hechas"] += 1
                print(f"[LINKEO] lista {item['titulo']}", flush=True)
            else:
                _anotar_error(item["curso"], item["titulo"], str(meta.get("error") or "No pude preparar esa clase."))
                print(f"[LINKEO] error {item['titulo']}: {meta.get('error') or 'sin detalle'}", flush=True)
    except Exception:
        traceback.print_exc()
        _anotar_error("", "", "Se detuvo el pase de clases.")
    finally:
        with LOCK:
            ESTADO["activo"] = False
            ESTADO["terminado"] = True
            ESTADO["actual"] = ""
            hechas = ESTADO["hechas"]
            ya = ESTADO["ya"]
            errores = len(ESTADO["errores"])
        print(f"[LINKEO] terminó. Listas {hechas}, ya estaban {ya}, avisos {errores}.", flush=True)


def comenzar(cursos) -> dict:
    if not isinstance(cursos, list) or not cursos:
        raise engine.AppError("No hay cursos para agregar.")
    with LOCK:
        if ESTADO["activo"]:
            raise engine.AppError("Ya estoy agregando las clases. Espera a que termine.")
        ESTADO["activo"] = True
        ESTADO["terminado"] = False
        ESTADO["total"] = 0
        ESTADO["hechas"] = 0
        ESTADO["ya"] = 0
        ESTADO["sin_video"] = 0
        ESTADO["futuras"] = 0
        ESTADO["anteriores"] = 0
        ESTADO["cursos"] = 0
        ESTADO["actual"] = ""
        ESTADO["errores"] = []
    threading.Thread(target=_trabajar, args=(cursos,), daemon=True).start()
    return foto()


class Handler(BaseHTTPRequestHandler):
    server_version = "LINKEODECLASESCLARA/1.0"

    def log_message(self, fmt: str, *args) -> None:
        line = args[0] if args else ""
        if isinstance(line, str) and line.startswith("GET /api/agregar"):
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

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self._error(404, "No encuentro esa página.")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            if path in ("/", "/LINKEODECLASESCLARA", "/LINKEODECLASESCLARA.html"):
                self._send_file(PAGINA, "text/html; charset=utf-8")
                return
            if path in ("/styles.css", "/static/styles.css"):
                self._send_file(STATIC / "styles.css", "text/css; charset=utf-8")
                return
            if path in ("/favicon.svg", "/static/favicon.svg"):
                self._send_file(STATIC / "favicon.svg", "image/svg+xml")
                return
            if path == "/api/programa":
                self._json(200, {"programa": True})
                return
            if path == "/api/agregar":
                self._json(200, foto())
                return
            if path == "/api/ultima":
                self._json(200, ULTIMA or {"cursos": []})
                return
            self._error(404, "No encuentro esa página.")
        except engine.AppError as exc:
            self._error(400, str(exc))
        except Exception:
            traceback.print_exc()
            self._error(500, "LINKEODECLASESCLARA tuvo un error interno.")

    def do_POST(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/linkeo":
                data = anotar_cursos(app.leer_clementina(self._read_json()))
                try:
                    pegar_presentaciones(data.get("cursos"))
                except Exception:
                    traceback.print_exc()
                global ULTIMA
                if isinstance(data, dict):
                    data["leido_en"] = int(time.time())
                    ULTIMA = data
                self._json(200, data)
                return
            if path == "/api/agregar":
                body = self._read_json()
                self._json(200, comenzar(body.get("cursos")))
                return
            self._error(404, "No encuentro esa acción.")
        except engine.AppError as exc:
            self._error(400, str(exc))
        except Exception:
            traceback.print_exc()
            self._error(500, "LINKEODECLASESCLARA tuvo un error interno.")


def make_server(port: int) -> ThreadingHTTPServer:
    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def serve(open_browser: bool = True) -> None:
    ocupado = socket.socket()
    try:
        ocupado.connect(("127.0.0.1", 8780))
    except OSError:
        ocupado.close()
    else:
        ocupado.close()
        print("LINKEODECLASESCLARA ya está abierto en http://127.0.0.1:8780/", flush=True)
        print("Usa esa página. Si abres otra ventana, la búsqueda se parte en dos.", flush=True)
        if open_browser:
            webbrowser.open("http://127.0.0.1:8780/")
        return
    server = None
    port = 8780
    for candidate in range(8780, 8790):
        try:
            server = make_server(candidate)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("No pude abrir un puerto local entre 8780 y 8789.")
    url = f"http://127.0.0.1:{port}"
    print(f"LINKEODECLASESCLARA en {url}", flush=True)
    print("Deja esta ventana abierta. Si la cierras, se detiene la lectura y el proceso.", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLINKEODECLASESCLARA cerrada.", flush=True)
    finally:
        server.server_close()


def self_test() -> None:
    largo = "Psicología del desarrollo " + ("tema " * 30)
    assert len(nombre_curso(largo)) <= 80
    assert nombre_curso("  Hola   mundo ") == "Hola mundo"
    assert titulo_clase({"numero": "4", "titulo": "Bases"}) == "Sesión 4 · Bases"
    assert titulo_clase({
        "numero": "1",
        "titulo": "Concepto de neurociencias y reseña histórica. Relación cerebro-conducta",
    }) == "Sesión 1 · Concepto de neurociencias y reseña histórica. Relación cerebro-conducta"
    assert titulo_asincronico("Sesión 1 · Sílabo") == "Sesión 1 · Asincrónica · Sílabo"
    assert titulo_asincronico("Sesión 1 · Asincrónica · Sílabo") == "Sesión 1 · Asincrónica · Sílabo"
    assert cita_asincronica(
        "VIDEOCONFERENCIA ASINCRONICA SESION 01 . 18 SETIEMBRE DE 20:30 A 23:00",
        "2026",
    ) == ("2026-09-18", "20:30")
    par = entradas_de([{
        "nombre": "Investigación",
        "sesiones": [{
            "numero": "1",
            "titulo": "Sílabo",
            "fecha_iso": "2026-09-13",
            "hora": "20:50",
            "enlaces": [
                {"nombre": "VIDEOCONFERENCIA SESIÓN 01", "url": "https://zoom.us/rec/share/en-vivo"},
                {
                    "nombre": "VIDEOCONFERENCIA ASINCRONICA SESION 01 . 18 SETIEMBRE DE 20:30 A 23:00",
                    "url": "https://zoom.us/rec/share/asincrona",
                },
            ],
        }],
    }], ahora=datetime(2026, 11, 1, 12, 0, tzinfo=LIMA))
    assert [item["titulo"] for item in par] == [
        "Sesión 1 · Sílabo",
        "Sesión 1 · Asincrónica · Sílabo",
    ]
    assert par[0]["fecha"] == "2026-09-13" and par[0]["hora"] == "20:50"
    assert par[1]["fecha"] == "2026-09-18" and par[1]["hora"] == "20:30"
    assert hora_inicio("19:00–21:00") == "19:00"
    assert hora_inicio("9:05") == "09:05"
    cursos = [{
        "nombre": "  Psicología del desarrollo  ",
        "profesor": "  Ana Pérez  ",
        "sesiones": [
            {
                "numero": "4",
                "titulo": "Bases",
                "fecha_iso": "2020-11-06",
                "hora": "19:00–21:00",
                "enlaces": [
                    {"url": "https://us02web.zoom.us/rec/share/abc", "zoom": True},
                    {"url": "https://zoom.us/j/123456", "zoom": True},
                    {"nombre": "Guía de lectura", "url": "https://ejemplo.com/a", "zoom": False},
                    {
                        "nombre": "Lectura 4.pdf",
                        "url": "https://uvcv.edu.pe/webservice/pluginfile.php/99/mod_resource/content/1/lectura.pdf?token=secreto",
                    },
                ],
                "presentaciones": [
                    {"nombre": "Bases.pptx", "url": "https://uvcv.edu.pe/pluginfile.php/1/Bases.pptx"},
                    {"nombre": "Zoom", "url": "https://zoom.us/rec/play/abcTOKEN1"},
                ],
            },
            {"numero": "5", "titulo": "Sin video", "enlaces": [
                {"nombre": "Lectura suelta.pdf", "url": "https://uvcv.edu.pe/pluginfile.php/8/lectura.pdf"},
            ]},
        ],
    }]
    entradas = entradas_de(cursos, ultimas={})
    assert len(entradas) == 1
    assert entradas[0]["titulo"] == "Sesión 4 · Bases"
    assert entradas[0]["hora"] == "19:00"
    assert entradas[0]["fecha"] == "2020-11-06"
    assert entradas[0]["profesor"] == "Ana Pérez"
    assert "/rec/share/" in entradas[0]["url"]
    assert "zoom.us/j/" not in entradas[0]["url"]
    assert entradas[0]["presentaciones"] == [
        {"nombre": "Bases.pptx", "url": "https://uvcv.edu.pe/pluginfile.php/1/Bases.pptx"},
    ]
    assert entradas[0]["lecturas"] == [
        {"nombre": "Guía de lectura", "url": "https://ejemplo.com/a"},
        {
            "nombre": "Lectura 4.pdf",
            "url": "https://uvcv.edu.pe/pluginfile.php/99/mod_resource/content/1/lectura.pdf",
        },
    ]
    assert contar_sesiones(cursos, ultimas={})["sin_video"] == 1
    assert cursos_nombrados(cursos) == ["Psicología del desarrollo"]

    fijo = datetime(2026, 11, 1, 12, 0, tzinfo=LIMA)
    corte = {"psicología del desarrollo": "2026-11-01"}
    rec = "https://us02web.zoom.us/rec/share/nueva"
    lote = [{
        "nombre": "Psicología del desarrollo",
        "sesiones": [
            {
                "numero": "1",
                "titulo": "Vieja",
                "fecha_iso": "2026-10-20",
                "hora": "15:20",
                "enlaces": [{"url": rec}],
            },
            {
                "numero": "2",
                "titulo": "Hoy más tarde",
                "fecha_iso": "2026-11-01",
                "hora": "15:20",
                "enlaces": [],
            },
            {
                "numero": "3",
                "titulo": "Futura con grabación",
                "fecha_iso": "2026-11-08",
                "hora": "15:20",
                "enlaces": [{"url": "https://zoom.us/rec/play/lista"}],
            },
            {
                "numero": "4",
                "titulo": "Lista",
                "fecha_iso": "2026-11-01",
                "hora": "09:00",
                "enlaces": [{"url": "https://zoom.us/rec/download/hoy"}],
            },
        ],
    }]
    elegidas = entradas_de(lote, ahora=fijo, ultimas=corte)
    assert [item["titulo"] for item in elegidas] == [
        "Sesión 1 · Vieja",
        "Sesión 3 · Futura con grabación",
        "Sesión 4 · Lista",
    ]
    assert clasificar_sesion(lote[0]["sesiones"][0], corte["psicología del desarrollo"], fijo) == ""
    assert clasificar_sesion(lote[0]["sesiones"][1], corte["psicología del desarrollo"], fijo) == "futura"
    cuentas = contar_sesiones(lote, ahora=fijo, ultimas=corte)
    assert cuentas == {"sin_video": 0, "futuras": 1, "anteriores": 0}
    marcado = anotar_cursos({"cursos": lote}, ahora=fijo, ultimas=corte)
    assert marcado["cursos"][0]["desde"] == ""
    assert marcado["cursos"][0]["sesiones"][0]["agregar"] is True
    assert marcado["cursos"][0]["sesiones"][1]["motivo"] == "futura"
    assert marcado["cursos"][0]["sesiones"][1]["agregar"] is False
    assert marcado["cursos"][0]["sesiones"][2]["agregar"] is True

    import tempfile

    real_classes = app.CLASSES
    real_list_fechas = cloud.list_cursos
    real_remotas_fechas = cloud.fechas_remotas
    try:
        with tempfile.TemporaryDirectory() as tmp:
            carpeta = Path(tmp) / "clase-1"
            carpeta.mkdir()
            (carpeta / "meta.json").write_text(json.dumps({
                "materia": "Psicología del desarrollo",
                "curso_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "fecha": "2026-10-30",
            }), encoding="utf-8")
            futura = Path(tmp) / "clase-2"
            futura.mkdir()
            (futura / "meta.json").write_text(json.dumps({
                "materia": "Otro curso",
                "fecha": "2026-12-01",
            }), encoding="utf-8")
            app.CLASSES = Path(tmp)
            cloud.list_cursos = lambda: [{
                "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "nombre": "Psicología del desarrollo",
            }]
            cloud.fechas_remotas = lambda: [
                {
                    "materia": "Psicología del desarrollo",
                    "curso_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                    "fecha": "2026-11-01",
                },
                {
                    "materia": "Psicología del desarrollo",
                    "curso_id": "",
                    "fecha": "2026-11-20",
                },
            ]
            guardadas = fechas_guardadas(fijo)
            assert guardadas["psicología del desarrollo"] == "2026-11-01"
            assert "otro curso" not in guardadas
    finally:
        app.CLASSES = real_classes
        cloud.list_cursos = real_list_fechas
        cloud.fechas_remotas = real_remotas_fechas

    real_filas = cloud.filas_fuentes
    cloud.filas_fuentes = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            app.CLASSES = Path(tmp)
            class_id = "20261101-120000-abc123"
            carpeta = Path(tmp) / class_id
            carpeta.mkdir()
            grabacion = "https://us02web.zoom.us/rec/share/abcTOKEN1"
            (carpeta / "meta.json").write_text(json.dumps({
                "id": class_id,
                "title": "Sesión 4 · Bases",
                "status": "ready",
                "video_url": grabacion,
            }), encoding="utf-8")
            (carpeta / "study.json").write_text(json.dumps({"titulo": "Bases"}), encoding="utf-8")
            antiguas = [{
                "nombre": "Psicología del desarrollo",
                "profesor": "Ana Pérez",
                "sesiones": [{
                    "numero": "4",
                    "titulo": "Bases",
                    "fecha_iso": "2020-11-06",
                    "hora": "19:00",
                    "enlaces": [
                        {"url": grabacion},
                        {"nombre": "Lectura 4.pdf", "url": "https://uvcv.edu.pe/pluginfile.php/9/Lectura%204.pdf"},
                    ],
                    "presentaciones": [
                        {"nombre": "Bases.pptx", "url": "https://uvcv.edu.pe/pluginfile.php/9/Bases.pptx"},
                    ],
                }],
            }]
            assert pegar_presentaciones(antiguas) == 1
            meta = json.loads((carpeta / "meta.json").read_text(encoding="utf-8"))
            estudio = json.loads((carpeta / "study.json").read_text(encoding="utf-8"))
            assert meta["presentaciones"][0]["nombre"] == "Bases.pptx"
            assert estudio["presentaciones"][0]["url"].endswith("/Bases.pptx")
            assert meta["lecturas"][0]["nombre"] == "Lectura 4.pdf"
            assert estudio["lecturas"][0]["url"].endswith("/Lectura%204.pdf")
            assert meta["profesor"] == "Ana Pérez"
            assert estudio["profesor"] == "Ana Pérez"
            assert meta["hora"] == "19:00"
            assert estudio["hora_clase"] == "19:00"
            assert meta["fecha"] == "2020-11-06"
            assert meta["fecha_origen"] == "clementina"
            assert estudio["fecha_clase"] == "2020-11-06"
            assert anotar_presentaciones(class_id, [], fecha="2099-01-01") is False
            assert json.loads((carpeta / "meta.json").read_text(encoding="utf-8"))["fecha"] == "2020-11-06"
            assert pegar_presentaciones([{"sesiones": [{"presentaciones": [], "enlaces": []}]}]) == 0
    finally:
        app.CLASSES = real_classes
        cloud.filas_fuentes = real_filas

    real_list = cloud.list_cursos
    real_crear = cloud.crear_curso
    real_crear_clase = app.create_class_from_url
    real_fechas = cloud.fechas_remotas
    creados = []

    def listar():
        return [{"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "nombre": nombre} for nombre in creados]

    def crear(nombre):
        creados.append(nombre)
        return {"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "nombre": nombre}

    def no_bajar(*args, **kwargs):
        raise AssertionError("no debía bajar un video")

    cloud.list_cursos = listar
    cloud.crear_curso = crear
    cloud.fechas_remotas = lambda: []
    app.create_class_from_url = no_bajar
    server = make_server(0)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as response:
            page = response.read()
            assert response.status == 200
            assert b"LINKEODECLASESCLARA" in page
            assert b"Agregar a ClaseClara" in page
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/programa") as response:
            assert json.loads(response.read().decode("utf-8"))["programa"] is True
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/styles.css") as response:
            assert b"--ink" in response.read()
        vacio = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/linkeo",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(vacio)
            raise AssertionError("la lectura vacía debía fallar")
        except urllib.error.HTTPError as exc:
            assert exc.code == 400
        pedido = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/agregar",
            data=json.dumps({"cursos": [{"nombre": "Psicología del desarrollo", "sesiones": []}]}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(pedido) as response:
            assert response.status == 200
        for _ in range(50):
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/agregar") as response:
                estado = json.loads(response.read().decode("utf-8"))
            if estado.get("terminado") and not estado.get("activo"):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("el pase no terminó")
        assert creados == ["Psicología del desarrollo"]
        assert estado["cursos"] == 1
        assert estado["total"] == 0
        assert estado["errores"] == []
    finally:
        cloud.list_cursos = real_list
        cloud.crear_curso = real_crear
        cloud.fechas_remotas = real_fechas
        app.create_class_from_url = real_crear_clase
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    import sys

    if "--probar" in sys.argv:
        self_test()
        print("ok")
    else:
        serve()

package com.claseclara.app;

import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Baja un Zoom y lo sube a YouTube sin pasar por la computadora. */
@CapacitorPlugin(name = "ClaseClaraYouTube")
public class YouTubePlugin extends Plugin {
    private static final int CHUNK = 8 * 1024 * 1024;
    private static final String AGENT = "Mozilla/5.0 (Linux; Android 14) ClaseClara";
    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void medir(PluginCall call) {
        String enlace = call.getString("enlace", "");
        if (!esZoom(enlace)) {
            call.reject("Ese enlace no es la grabación de Zoom.");
            return;
        }
        execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = abrir(enlace, "bytes=0-0");
                int status = conn.getResponseCode();
                String tipo = String.valueOf(conn.getContentType() == null ? "" : conn.getContentType()).toLowerCase(Locale.US);
                if (tipo.contains("text/html")) {
                    call.reject("Ese enlace no entregó el video. Tiene que abrir la grabación sin clave.");
                    return;
                }
                long bytes = totalDe(conn, status);
                if (bytes < 1000) {
                    call.reject("El enlace no devolvió un video completo.");
                    return;
                }
                JSObject data = new JSObject();
                data.put("bytes", bytes);
                data.put("tipo", tipo.startsWith("audio/") ? tipo : "video/mp4");
                data.put("nombre", nombreDe(conn.getHeaderField("Content-Disposition")));
                call.resolve(data);
            } catch (Exception error) {
                call.reject("No pude bajar el video de Zoom.");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void subir(PluginCall call) {
        String enlace = call.getString("enlace", "");
        String sesion = call.getString("sesion", "");
        Double size = call.getDouble("bytes", 0d);
        long total = size == null ? 0 : size.longValue();
        if (!esZoom(enlace) || !esYouTube(sesion) || total < 1000) {
            call.reject("No pude abrir la subida a YouTube.");
            return;
        }
        execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = abrir(enlace, null);
                int status = conn.getResponseCode();
                if (status >= 400) {
                    call.reject("No pude bajar el video de Zoom.");
                    return;
                }
                String tipo = String.valueOf(conn.getContentType() == null ? "" : conn.getContentType()).toLowerCase(Locale.US);
                if (tipo.contains("text/html")) {
                    call.reject("Ese enlace no entregó el video. Tiene que abrir la grabación sin clave.");
                    return;
                }
                String watch = enviar(conn.getInputStream(), sesion, total, call);
                JSObject data = new JSObject();
                data.put("watch", watch);
                call.resolve(data);
            } catch (Exception error) {
                call.reject("No pude subir el video a YouTube.");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private String enviar(InputStream input, String sesion, long total, PluginCall call) throws Exception {
        byte[] buf = new byte[CHUNK];
        long start = 0;
        while (start < total) {
            int need = (int) Math.min(buf.length, total - start);
            int got = 0;
            while (got < need) {
                int read = input.read(buf, got, need - got);
                if (read < 0) break;
                got += read;
            }
            if (got <= 0) throw new IllegalStateException("corto");
            String watch = poner(sesion, buf, got, start, total);
            start += got;
            int percent = (int) Math.min(100, Math.round(start * 100.0 / total));
            avisar(call, "Subiendo a YouTube… " + percent + "%");
            if (watch != null) return watch;
        }
        throw new IllegalStateException("incompleto");
    }

    private String poner(String sesion, byte[] buf, int length, long start, long total) throws Exception {
        HttpURLConnection put = (HttpURLConnection) new URL(sesion).openConnection();
        put.setInstanceFollowRedirects(false);
        put.setConnectTimeout(30000);
        put.setReadTimeout(300000);
        put.setDoOutput(true);
        put.setRequestMethod("PUT");
        put.setFixedLengthStreamingMode(length);
        put.setRequestProperty("Content-Type", "video/mp4");
        put.setRequestProperty("Content-Range", "bytes " + start + "-" + (start + length - 1) + "/" + total);
        try (OutputStream out = put.getOutputStream()) {
            out.write(buf, 0, length);
        }
        int status = put.getResponseCode();
        if (status == 308) {
            put.disconnect();
            return null;
        }
        if (status != 200 && status != 201) {
            put.disconnect();
            throw new IllegalStateException("youtube");
        }
        String raw = leer(put.getInputStream());
        put.disconnect();
        String id = new JSONObject(raw).optString("id", "");
        if (!id.matches("[A-Za-z0-9_-]{11}")) throw new IllegalStateException("id");
        return "https://www.youtube.com/watch?v=" + id;
    }

    private void avisar(PluginCall call, String detalle) {
        JSObject data = new JSObject();
        data.put("detalle", detalle);
        main.post(() -> notifyListeners("progreso", data));
    }

    private HttpURLConnection abrir(String enlace, String range) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(enlace).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("User-Agent", AGENT);
        if (range != null) conn.setRequestProperty("Range", range);
        return conn;
    }

    private static long totalDe(HttpURLConnection conn, int status) {
        String range = conn.getHeaderField("Content-Range");
        if (range != null) {
            Matcher match = Pattern.compile("/(\\d+)\\s*$").matcher(range.trim());
            if (match.find()) return Long.parseLong(match.group(1));
        }
        if (status == 200) return Math.max(0, conn.getContentLengthLong());
        return 0;
    }

    private static String nombreDe(String disposition) {
        if (disposition == null) return "";
        Matcher match = Pattern.compile("filename\\*?=(?:UTF-8''|\"?)([^\";]+)", Pattern.CASE_INSENSITIVE).matcher(disposition);
        if (!match.find()) return "";
        try {
            return URLDecoder.decode(match.group(1).replace("\"", ""), StandardCharsets.UTF_8.name());
        } catch (Exception error) {
            return "";
        }
    }

    private static String leer(InputStream input) throws Exception {
        byte[] data = new byte[20000];
        int got = 0;
        while (got < data.length) {
            int read = input.read(data, got, data.length - got);
            if (read < 0) break;
            got += read;
        }
        return new String(data, 0, got, StandardCharsets.UTF_8);
    }

    private static boolean esZoom(String value) {
        try {
            URL url = new URL(value);
            String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.US);
            return "https".equalsIgnoreCase(url.getProtocol()) && host.endsWith("zoom.us") && value.length() <= 2000;
        } catch (Exception error) {
            return false;
        }
    }

    private static boolean esYouTube(String value) {
        try {
            URL url = new URL(value);
            String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.US);
            return "https".equalsIgnoreCase(url.getProtocol())
                && (host.equals("www.googleapis.com") || host.endsWith(".googleapis.com"))
                && value.contains("/upload/");
        } catch (Exception error) {
            return false;
        }
    }
}

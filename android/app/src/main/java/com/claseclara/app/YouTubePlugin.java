package com.claseclara.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
            Context context = getContext();
            Copia copia = context == null ? null : Copia.abrir(context.getCacheDir(), total);
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
                String watch = enviar(conn.getInputStream(), sesion, total, call, copia);
                JSONArray tomas = new JSONArray();
                File video = copia == null || context == null ? null : copia.lista(total);
                if (video != null) {
                    avisar(call, "Guardando capturas…");
                    tomas = tomasDeRuta(video, context.getCacheDir());
                }
                JSObject data = new JSObject();
                data.put("watch", watch);
                ponerTomas(data, tomas);
                call.resolve(data);
            } catch (Exception error) {
                call.reject("No pude subir el video a YouTube.");
            } finally {
                if (conn != null) conn.disconnect();
                if (copia != null) copia.borrar();
            }
        });
    }

    @PluginMethod
    public void capturar(PluginCall call) {
        String archivo = call.getString("archivo", "");
        if (!esVideoLocal(archivo)) {
            JSObject data = new JSObject();
            ponerTomas(data, new JSONArray());
            call.resolve(data);
            return;
        }
        execute(() -> {
            JSObject data = new JSObject();
            ponerTomas(data, tomasDeUri(archivo));
            call.resolve(data);
        });
    }

    private String enviar(InputStream input, String sesion, long total, PluginCall call, Copia copia) throws Exception {
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
            if (copia != null) copia.write(buf, got);
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

    private static void ponerTomas(JSObject data, JSONArray tomas) {
        try {
            data.put("tomas", tomas == null ? new JSONArray() : tomas);
        } catch (Exception error) {
            try { data.put("tomas", new JSONArray()); } catch (Exception ignored) { }
        }
    }

    private JSONArray tomasDeUri(String uri) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            if (uri.startsWith("file://")) {
                String path = Uri.parse(uri).getPath();
                if (!esRutaPropia(path)) return new JSONArray();
                retriever.setDataSource(path);
            } else {
                Context context = getContext();
                if (context == null) return new JSONArray();
                retriever.setDataSource(context, Uri.parse(uri));
            }
            return cuadrosDe(retriever);
        } catch (Exception error) {
            return new JSONArray();
        } finally {
            try { retriever.release(); } catch (Exception ignored) { }
        }
    }

    private JSONArray tomasDeRuta(File video, File cache) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            String path = video.getCanonicalPath();
            String root = cache.getCanonicalPath();
            if (!path.startsWith(root + File.separator)) return new JSONArray();
            retriever.setDataSource(path);
            return cuadrosDe(retriever);
        } catch (Exception error) {
            return new JSONArray();
        } finally {
            try { retriever.release(); } catch (Exception ignored) { }
        }
    }

    private static JSONArray cuadrosDe(MediaMetadataRetriever retriever) {
        JSONArray out = new JSONArray();
        try {
            String raw = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            long ms = raw == null ? 0 : Long.parseLong(raw);
            if (ms < 400) return out;
            double duration = ms / 1000.0;
            double step = pasoDe(duration);
            double fin = Math.max(0.2, duration - 0.05);
            double early = Math.min(2.0, duration / 3.0);
            List<Toma> cambios = new ArrayList<>();
            int[] anterior = null;
            Toma temprana = null;
            int guard = 0;
            for (double cursor = Math.min(0.3, fin); cursor <= fin + 0.001 && guard < 240; cursor += step) {
                guard += 1;
                double at = Math.min(fin, Math.max(0.1, cursor));
                Muestra muestra = cuadroEn(retriever, at);
                if (muestra == null) continue;
                if (temprana == null && at + 0.001 >= Math.min(early, fin)) {
                    temprana = new Toma(at, muestra.avg, muestra.bits);
                }
                if (anterior != null && diferencia(anterior, muestra.vals) < 0.18) {
                    anterior = muestra.vals;
                    continue;
                }
                cambios.add(new Toma(at, muestra.avg, muestra.bits));
                anterior = muestra.vals;
            }
            if (temprana != null && !cerca(cambios, temprana.time)) cambios.add(0, temprana);
            List<Toma> elegidas = elegirTomas(cambios);
            if (elegidas.isEmpty()) {
                elegidas.add(new Toma(duration > 0 ? Math.min(8.0, duration / 2.0) : 1.0, 128, 0));
            }
            for (Toma toma : elegidas) {
                if (out.length() >= 8) break;
                String jpeg = jpegEn(retriever, toma.time);
                if (jpeg.length() < 500) continue;
                JSONObject item = new JSONObject();
                item.put("jpeg", jpeg);
                item.put("tiempo", Math.round(toma.time * 100.0) / 100.0);
                out.put(item);
            }
        } catch (Exception ignored) {
            return out;
        }
        return out;
    }

    private static double pasoDe(double duration) {
        if (duration <= 15) return Math.max(0.35, duration / 10.0);
        double step = Math.max(6.0, duration / 180.0);
        if (duration / step > 220) step = duration / 220.0;
        return Math.min(step, 30.0);
    }

    private static boolean cerca(List<Toma> items, double time) {
        for (Toma item : items) {
            if (Math.abs(item.time - time) < 0.4) return true;
        }
        return false;
    }

    private static List<Toma> elegirTomas(List<Toma> items) {
        List<Toma> usable = new ArrayList<>();
        for (Toma item : items) {
            if (item.avg >= 6 && item.avg <= 250) usable.add(item);
        }
        List<Toma> pool = new ArrayList<>(usable.isEmpty() ? items : usable);
        pool.sort((a, b) -> Double.compare(a.time, b.time));
        List<Toma> kept = new ArrayList<>();
        for (Toma item : pool) {
            if (!kept.isEmpty()) {
                Toma last = kept.get(kept.size() - 1);
                if (item.bits == last.bits && Math.abs(item.time - last.time) < 8) continue;
            }
            kept.add(item);
        }
        if (kept.size() <= 8) return kept;
        List<Toma> picked = new ArrayList<>();
        int lastIndex = -1;
        int span = kept.size() - 1;
        for (int index = 0; index < 8; index++) {
            int choose = (int) Math.round(index * (double) span / 7.0);
            if (choose == lastIndex) continue;
            picked.add(kept.get(choose));
            lastIndex = choose;
        }
        return picked;
    }

    private static Muestra cuadroEn(MediaMetadataRetriever retriever, double seconds) {
        Bitmap frame = null;
        Bitmap small = null;
        try {
            long mark = (long) (seconds * 1000000.0);
            frame = retriever.getFrameAtTime(mark, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (frame == null) frame = retriever.getFrameAtTime(mark, MediaMetadataRetriever.OPTION_CLOSEST);
            if (frame == null) return null;
            int width = Math.min(160, Math.max(1, frame.getWidth()));
            int height = Math.max(1, Math.round(frame.getHeight() * (width / (float) frame.getWidth())));
            small = width == frame.getWidth() ? frame : Bitmap.createScaledBitmap(frame, width, height, true);
            if (small != frame) {
                frame.recycle();
                frame = null;
            }
            return muestraDe(small, seconds);
        } catch (Exception error) {
            return null;
        } finally {
            if (frame != null && frame != small && !frame.isRecycled()) frame.recycle();
            if (small != null && !small.isRecycled()) small.recycle();
        }
    }

    private static String jpegEn(MediaMetadataRetriever retriever, double seconds) {
        Bitmap frame = null;
        Bitmap scaled = null;
        try {
            long mark = (long) (seconds * 1000000.0);
            frame = retriever.getFrameAtTime(mark, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (frame == null) frame = retriever.getFrameAtTime(mark, MediaMetadataRetriever.OPTION_CLOSEST);
            if (frame == null) return "";
            scaled = escalar(frame);
            if (scaled != frame) {
                frame.recycle();
                frame = null;
            }
            return jpegDe(scaled);
        } catch (Exception error) {
            return "";
        } finally {
            if (frame != null && frame != scaled && !frame.isRecycled()) frame.recycle();
            if (scaled != null && !scaled.isRecycled()) scaled.recycle();
        }
    }

    private static Muestra muestraDe(Bitmap bitmap, double time) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        if (width < 2 || height < 2) return null;
        int[] vals = new int[256];
        long sum = 0;
        int count = 0;
        for (int y = 0; y < 16; y++) {
            int py = Math.min(height - 1, (int) ((y + 0.5) * height / 16.0));
            for (int x = 0; x < 16; x++) {
                int px = Math.min(width - 1, (int) ((x + 0.5) * width / 16.0));
                int pixel = bitmap.getPixel(px, py);
                int lum = (((pixel >> 16) & 255) * 3 + ((pixel >> 8) & 255) * 6 + (pixel & 255)) / 10;
                vals[count] = lum;
                sum += lum;
                count += 1;
            }
        }
        double avg = sum / (double) vals.length;
        long bits = 0;
        int bit = 0;
        for (int y = 0; y < 16; y += 2) {
            for (int x = 0; x < 16; x += 2) {
                if (vals[y * 16 + x] >= avg) bits |= 1L << bit;
                bit += 1;
            }
        }
        return new Muestra(time, avg, bits, vals);
    }

    private static double diferencia(int[] antes, int[] ahora) {
        int n = Math.min(antes.length, ahora.length);
        if (n == 0) return 0;
        long sum = 0;
        for (int index = 0; index < n; index++) sum += Math.abs(antes[index] - ahora[index]);
        return (sum / (double) n) / 255.0;
    }

    private static final class Muestra {
        final double avg;
        final long bits;
        final int[] vals;

        Muestra(double time, double avg, long bits, int[] vals) {
            this.avg = avg;
            this.bits = bits;
            this.vals = vals;
        }
    }

    private static final class Toma {
        final double time;
        final double avg;
        final long bits;

        Toma(double time, double avg, long bits) {
            this.time = time;
            this.avg = avg;
            this.bits = bits;
        }
    }

    private static Bitmap escalar(Bitmap frame) {
        int width = frame.getWidth();
        int height = frame.getHeight();
        if (width <= 0 || height <= 0 || width <= 960) return frame;
        int next = Math.max(1, Math.round(height * (960f / width)));
        return Bitmap.createScaledBitmap(frame, 960, next, true);
    }

    private static String jpegDe(Bitmap bitmap) {
        int quality = 68;
        ByteArrayOutputStream stream = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream);
        while (stream.size() > 280000 && quality > 40) {
            quality -= 10;
            stream.reset();
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream);
        }
        if (stream.size() < 300 || stream.size() > 280000) return "";
        byte[] bytes = stream.toByteArray();
        if ((bytes[0] & 0xff) != 0xff || (bytes[1] & 0xff) != 0xd8) return "";
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private static boolean esVideoLocal(String value) {
        if (value == null || value.length() < 16 || value.length() > 600) return false;
        if (value.contains("..") || value.contains("\\") || value.contains("\n") || value.contains("\r")) return false;
        String lower = value.toLowerCase(Locale.US);
        if (!lower.startsWith("content://") && !lower.startsWith("file://")) return false;
        if (!lower.contains("com.claseclara.app")) return false;
        if (!lower.contains("/videos/") && !lower.contains("%2fvideos%2f")) return false;
        return lower.contains(".mp4");
    }

    private static boolean esRutaPropia(String path) {
        if (path == null || path.contains("..")) return false;
        String lower = path.toLowerCase(Locale.US);
        return lower.contains("/com.claseclara.app/") && lower.contains("/videos/") && lower.endsWith(".mp4");
    }

    private static final class Copia {
        private final File file;
        private FileOutputStream out;
        private long written;
        private boolean ok = true;

        private Copia(File file, FileOutputStream out) {
            this.file = file;
            this.out = out;
        }

        static Copia abrir(File dir, long total) {
            File file = null;
            try {
                if (dir == null || total < 1000) return null;
                if (dir.getUsableSpace() < total + 50000000L) return null;
                file = File.createTempFile("cc-zoom-", ".mp4", dir);
                return new Copia(file, new FileOutputStream(file));
            } catch (Exception error) {
                if (file != null) file.delete();
                return null;
            }
        }

        void write(byte[] buf, int len) {
            if (!ok || out == null) return;
            try {
                out.write(buf, 0, len);
                written += len;
            } catch (Exception error) {
                ok = false;
            }
        }

        File lista(long total) {
            try {
                if (out != null) out.close();
            } catch (Exception error) {
                ok = false;
            }
            out = null;
            if (!ok || file == null || written != total || !file.isFile() || file.length() != total) return null;
            return file;
        }

        void borrar() {
            try {
                if (out != null) out.close();
            } catch (Exception ignored) { }
            out = null;
            if (file != null) file.delete();
        }
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

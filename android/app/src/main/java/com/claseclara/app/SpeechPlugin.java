package com.claseclara.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Lee el texto con la voz del teléfono. El navegador del APK no puede usar ese motor. */
@CapacitorPlugin(name = "ClaseClaraSpeech")
public class SpeechPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean focused = false;
    private boolean ready = false;
    private boolean failed = false;
    private boolean triedGoogle = false;
    private boolean relaxed = false;
    private boolean heard = false;
    private int generation = 0;
    private int retries = 0;
    private boolean reading = false;
    private final List<String> pendingParts = new ArrayList<>();
    private PluginCall active;
    private Context appContext;
    private PowerManager.WakeLock wakeLock;
    private static SpeechPlugin live;

    static void stopFromNotification() {
        SpeechPlugin plugin = live;
        if (plugin == null) return;
        plugin.main.post(plugin::stopOnMain);
    }

    @Override
    public void load() {
        live = this;
        Context context = getContext();
        appContext = context != null ? context.getApplicationContext() : null;
        tts = new TextToSpeech(context, status -> main.post(() -> onReady(status)));
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        ready = false;
        endReading();
        PluginCall current = active;
        active = null;
        pendingParts.clear();
        if (current != null) current.resolve();
        abandonFocus();
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (RuntimeException ignored) {
                // The engine was already gone.
            }
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        main.post(() -> speakOnMain(call));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            stopOnMain();
            call.resolve();
        });
    }

    private void onReady(int status) {
        if (tts == null) return;
        if (status != TextToSpeech.SUCCESS) {
            if (!triedGoogle) {
                triedGoogle = true;
                try {
                    tts.shutdown();
                } catch (RuntimeException ignored) {
                    // The first engine never started.
                }
                tts = new TextToSpeech(getContext(), next -> main.post(() -> onReady(next)), "com.google.android.tts");
                return;
            }
            failed = true;
            finish(false, "sin voz");
            return;
        }
        ready = true;
        try {
            tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
        } catch (RuntimeException ignored) {
            // The engine still speaks with its own stream.
        }
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                main.post(() -> {
                    if (!matches(utteranceId)) return;
                    heard = true;
                    int index = pieceIndex(utteranceId);
                    if (index < 0) return;
                    JSObject data = new JSObject();
                    data.put("index", index);
                    notifyListeners("piece", data);
                });
            }

            @Override
            public void onDone(String utteranceId) {
                if (utteranceId == null || !utteranceId.endsWith(":last")) return;
                main.post(() -> {
                    if (active != null && matches(utteranceId)) finish(true, "");
                });
            }

            @Override
            public void onError(String utteranceId) {
                main.post(() -> onPieceFailed(utteranceId));
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                onError(utteranceId);
            }

            @Override
            public void onStop(String utteranceId, boolean interrupted) {
                main.post(() -> onPieceFailed(utteranceId));
            }
        });
        applySpanish();
        if (active != null && !pendingParts.isEmpty()) speakNow();
    }

    private void speakOnMain(PluginCall call) {
        PluginCall previous = active;
        active = null;
        generation += 1;
        if (previous != null) previous.resolve();
        active = call;
        retries = 0;
        relaxed = false;
        heard = false;
        pendingParts.clear();
        pendingParts.addAll(textsOf(call));
        if (pendingParts.isEmpty() || failed || tts == null) {
            finish(false, "sin voz");
            return;
        }
        if (!ready) return;
        speakNow();
    }

    private List<String> textsOf(PluginCall call) {
        List<String> list = new ArrayList<>();
        JSArray array = call.getArray("texts");
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                String item = array.optString(i, "").trim();
                if (!item.isEmpty()) list.add(item);
            }
        }
        if (list.isEmpty()) {
            String text = call.getString("text", "");
            if (text != null && !text.trim().isEmpty()) list.add(text.trim());
        }
        return list;
    }

    private void speakNow() {
        if (tts == null || active == null) return;
        beginReading();
        try {
            speakPieces(pendingParts);
        } catch (RuntimeException ex) {
            retryOrFail();
            return;
        }
        armWatch();
    }

    private void armWatch() {
        int mine = generation;
        main.postDelayed(() -> {
            if (active == null || generation != mine || heard) return;
            if (retries < 1) {
                retryOrFail();
                return;
            }
            finish(false, "sin voz");
        }, 5000);
    }

    private void speakPieces(List<String> texts) {
        if (texts == null || texts.isEmpty()) {
            finish(false, "sin voz");
            return;
        }
        requestFocus();
        applySpanish();
        applyRate();
        int max = 3200;
        try {
            int cap = TextToSpeech.getMaxSpeechInputLength();
            if (cap > 200 && cap < max) max = cap;
        } catch (RuntimeException ignored) {
            // Keep the safe limit.
        }
        List<String> pieces = new ArrayList<>();
        List<Integer> origins = new ArrayList<>();
        for (int index = 0; index < texts.size(); index++) {
            String spoken = texts.get(index) == null ? "" : texts.get(index).trim();
            int start = 0;
            if (spoken.isEmpty()) continue;
            while (start < spoken.length()) {
                int end = Math.min(spoken.length(), start + max);
                if (end < spoken.length()) {
                    int space = spoken.lastIndexOf(' ', end);
                    if (space > start + 40) end = space;
                }
                String piece = spoken.substring(start, end).trim();
                if (!piece.isEmpty()) {
                    pieces.add(piece);
                    origins.add(index);
                }
                if (end <= start) break;
                start = end;
            }
        }
        if (pieces.isEmpty()) {
            finish(false, "sin voz");
            return;
        }
        int queue = TextToSpeech.QUEUE_FLUSH;
        int mine = generation;
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
        for (int index = 0; index < pieces.size(); index++) {
            boolean last = index == pieces.size() - 1;
            String pieceId = mine + ":" + origins.get(index) + ":" + index + (last ? ":last" : "");
            int result = tts.speak(pieces.get(index), queue, params, pieceId);
            if (result == TextToSpeech.ERROR) {
                retryOrFail();
                return;
            }
            queue = TextToSpeech.QUEUE_ADD;
        }
    }

    private void onPieceFailed(String utteranceId) {
        if (active == null || !matches(utteranceId)) return;
        boolean last = utteranceId != null && utteranceId.endsWith(":last");
        if (!last && heard) return;
        if (!heard && retries < 1) {
            retryOrFail();
            return;
        }
        finish(heard, heard ? "" : "sin voz");
    }

    private void retryOrFail() {
        if (retries >= 1 || active == null) {
            finish(false, "sin voz");
            return;
        }
        retries += 1;
        relaxed = true;
        heard = false;
        generation += 1;
        main.postDelayed(() -> {
            if (active != null) speakNow();
        }, 300);
    }

    private void stopOnMain() {
        generation += 1;
        PluginCall current = active;
        active = null;
        pendingParts.clear();
        if (tts != null) {
            try {
                tts.stop();
            } catch (RuntimeException ignored) {
                // Nothing was speaking.
            }
        }
        abandonFocus();
        endReading();
        if (current != null) current.resolve();
    }

    private boolean matches(String utteranceId) {
        return pieceGeneration(utteranceId) == generation;
    }

    private int pieceGeneration(String utteranceId) {
        if (utteranceId == null) return -1;
        int mark = utteranceId.indexOf(':');
        if (mark <= 0) return -1;
        try {
            return Integer.parseInt(utteranceId.substring(0, mark));
        } catch (NumberFormatException ex) {
            return -1;
        }
    }

    private int pieceIndex(String utteranceId) {
        if (utteranceId == null) return -1;
        String[] bits = utteranceId.split(":");
        if (bits.length < 2) return -1;
        try {
            return Integer.parseInt(bits[1]);
        } catch (NumberFormatException ex) {
            return -1;
        }
    }

    private void finish(boolean ok, String reason) {
        PluginCall current = active;
        active = null;
        pendingParts.clear();
        abandonFocus();
        endReading();
        if (current == null) return;
        if (ok) current.resolve();
        else current.reject(reason == null || reason.isEmpty() ? "sin voz" : reason);
    }

    private void beginReading() {
        reading = true;
        holdWake();
        if (appContext == null) return;
        try {
            ReadingService.start(appContext);
        } catch (RuntimeException ignored) {
            // The voice still plays if the service cannot start.
        }
    }

    private void endReading() {
        reading = false;
        releaseWake();
        if (appContext == null) return;
        try {
            ReadingService.dismiss(appContext);
        } catch (RuntimeException ignored) {
            // The service was already gone.
        }
    }

    private void holdWake() {
        if (appContext == null || (wakeLock != null && wakeLock.isHeld())) return;
        try {
            PowerManager manager = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
            if (manager == null) return;
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ClaseClara:lectura");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(6L * 60L * 60L * 1000L);
        } catch (RuntimeException ignored) {
            // The voice still plays if the lock is unavailable.
        }
    }

    private void releaseWake() {
        if (wakeLock == null) return;
        try {
            if (wakeLock.isHeld()) wakeLock.release();
        } catch (RuntimeException ignored) {
            // The lock was already released.
        }
        wakeLock = null;
    }

    private void applyRate() {
        if (tts == null || active == null) return;
        Double rate = active.getDouble("rate", 1d);
        float value = rate == null ? 1f : rate.floatValue();
        if (value < 0.5f || value > 2f) value = 1f;
        tts.setSpeechRate(value);
    }

    private void applySpanish() {
        if (tts == null) return;
        if (relaxed) {
            tts.setLanguage(Locale.getDefault());
            return;
        }
        Locale[] locales = {
                new Locale("es", "PE"),
                new Locale("es", "MX"),
                new Locale("es", "US"),
                new Locale("es", "ES"),
                new Locale("es"),
        };
        for (Locale locale : locales) {
            int result = tts.setLanguage(locale);
            if (result >= TextToSpeech.LANG_AVAILABLE) return;
        }
    }

    private void requestFocus() {
        if (focused) return;
        Context context = getContext();
        if (context == null) return;
        if (audioManager == null) {
            audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        }
        if (audioManager == null) return;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attrs)
                    .build();
            result = audioManager.requestAudioFocus(focusRequest);
        } else {
            result = requestFocusLegacy();
        }
        focused = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    @SuppressWarnings("deprecation")
    private int requestFocusLegacy() {
        return audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
    }

    private void abandonFocus() {
        if (!focused || audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            abandonFocusLegacy();
        }
        focused = false;
    }

    @SuppressWarnings("deprecation")
    private void abandonFocusLegacy() {
        audioManager.abandonAudioFocus(null);
    }
}

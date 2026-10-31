package com.claseclara.app;

import android.media.AudioAttributes;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;

/** Lee el texto con la voz del teléfono. El navegador del APK no puede usar ese motor. */
@CapacitorPlugin(name = "ClaseClaraSpeech")
public class SpeechPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ready = false;
    private boolean failed = false;
    private int generation = 0;
    private PluginCall active;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> main.post(() -> onReady(status)));
    }

    @Override
    protected void handleOnDestroy() {
        ready = false;
        PluginCall current = active;
        active = null;
        if (current != null) current.resolve();
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
            failed = true;
            finish(false);
            return;
        }
        ready = true;
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
            }

            @Override
            public void onDone(String utteranceId) {
                if (utteranceId == null || !utteranceId.endsWith(":last")) return;
                int seen = pieceGeneration(utteranceId);
                main.post(() -> {
                    if (seen == generation) finish(true);
                });
            }

            @Override
            public void onError(String utteranceId) {
                int seen = pieceGeneration(utteranceId);
                main.post(() -> {
                    if (active == null) return;
                    if (utteranceId == null || seen == generation) finish(false);
                });
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                onError(utteranceId);
            }
        });
        applySpanish();
        if (active != null) speakNow(active.getString("text", ""));
    }

    private void speakOnMain(PluginCall call) {
        stopOnMain();
        active = call;
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty() || failed || tts == null) {
            finish(false);
            return;
        }
        if (!ready) return;
        speakNow(text.trim());
    }

    private void speakNow(String spoken) {
        if (tts == null || active == null) return;
        spoken = spoken == null ? "" : spoken.trim();
        if (spoken.isEmpty()) {
            finish(false);
            return;
        }
        applySpanish();
        applyRate();
        int max = TextToSpeech.getMaxSpeechInputLength();
        if (max < 200) max = 3900;
        int queue = TextToSpeech.QUEUE_FLUSH;
        int start = 0;
        int index = 0;
        int mine = generation;
        while (start < spoken.length()) {
            int end = Math.min(spoken.length(), start + max);
            boolean last = end >= spoken.length();
            String pieceId = mine + ":" + index + (last ? ":last" : "");
            int result = tts.speak(spoken.substring(start, end), queue, null, pieceId);
            if (result == TextToSpeech.ERROR) {
                finish(false);
                return;
            }
            queue = TextToSpeech.QUEUE_ADD;
            start = end;
            index += 1;
        }
    }

    private void stopOnMain() {
        generation += 1;
        PluginCall current = active;
        active = null;
        if (tts != null) {
            try {
                tts.stop();
            } catch (RuntimeException ignored) {
                // Nothing was speaking.
            }
        }
        if (current != null) current.resolve();
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

    private void finish(boolean ok) {
        PluginCall current = active;
        active = null;
        if (current == null) return;
        if (ok) current.resolve();
        else current.reject("sin voz");
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
}

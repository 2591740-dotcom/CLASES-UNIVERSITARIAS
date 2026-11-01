package com.claseclara.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean backBusy = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SpeechPlugin.class);
        registerPlugin(YouTubePlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setOffscreenPreRaster(true);
        String agent = settings.getUserAgentString();
        if (agent != null && agent.contains("; wv")) {
            settings.setUserAgentString(agent.replace("; wv", ""));
        }
        // Capacitor no trae el botón Atrás. Sin esto, Android cierra la app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (backBusy) return;
                WebView view = getBridge() != null ? getBridge().getWebView() : null;
                if (view == null) {
                    leaveApp(this);
                    return;
                }
                backBusy = true;
                OnBackPressedCallback callback = this;
                view.evaluateJavascript(
                    "(function(){try{return window.claseClaraAtras?window.claseClaraAtras():false;}catch(e){return false;}})()",
                    result -> {
                        backBusy = false;
                        if (!"true".equals(result)) leaveApp(callback);
                    }
                );
            }
        });
    }

    private void leaveApp(OnBackPressedCallback callback) {
        callback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        callback.setEnabled(true);
    }
}

package com.claseclara.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

/** Mantiene la lectura cuando la pantalla se apaga. */
public class ReadingService extends Service {
    static final String ACTION_START = "com.claseclara.app.lectura.START";
    static final String ACTION_STOP = "com.claseclara.app.lectura.STOP";
    private static final String CHANNEL = "lectura";
    private static final int NOTIF_ID = 4104;

    private PowerManager.WakeLock wakeLock;
    private MediaSession session;

    static void start(Context context) {
        Intent intent = new Intent(context, ReadingService.class);
        intent.setAction(ACTION_START);
        ContextCompat.startForegroundService(context, intent);
    }

    static void dismiss(Context context) {
        context.stopService(new Intent(context, ReadingService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            SpeechPlugin.stopFromNotification();
            shutdown();
            return START_NOT_STICKY;
        }
        holdWake();
        openSession();
        showOngoing();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        releaseWake();
        closeSession();
        super.onDestroy();
    }

    private void showOngoing() {
        ensureChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, notification);
        }
    }

    private void shutdown() {
        releaseWake();
        closeSession();
        stopForeground(true);
        stopSelf();
    }

    private Notification buildNotification() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(
                this,
                1,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                flags);
        PendingIntent stop = PendingIntent.getService(
                this,
                2,
                new Intent(this, ReadingService.class).setAction(ACTION_STOP),
                flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("ClaseClara")
                .setContentText("Está leyendo")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_pause,
                        "Detener",
                        stop).build());
        if (session != null) {
            builder.setStyle(new Notification.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0));
        }
        return builder.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "Lectura en voz alta", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Sigue leyendo con la pantalla apagada");
        channel.setSound(null, null);
        channel.enableVibration(false);
        manager.createNotificationChannel(channel);
    }

    private void openSession() {
        if (session != null) {
            markPlaying();
            return;
        }
        session = new MediaSession(this, "ClaseClaraLectura");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPause() {
                SpeechPlugin.stopFromNotification();
            }

            @Override
            public void onStop() {
                SpeechPlugin.stopFromNotification();
            }
        }, new Handler(Looper.getMainLooper()));
        session.setActive(true);
        markPlaying();
    }

    private void markPlaying() {
        if (session == null) return;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_STOP | PlaybackState.ACTION_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
    }

    private void closeSession() {
        if (session == null) return;
        try {
            session.setActive(false);
            session.release();
        } catch (RuntimeException ignored) {
            // The session was already closed.
        }
        session = null;
    }

    private void holdWake() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ClaseClara:lectura");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(6L * 60L * 60L * 1000L);
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
}

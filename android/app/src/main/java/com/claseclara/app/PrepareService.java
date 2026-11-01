package com.claseclara.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

/** Mantiene la preparación y la subida con la pantalla apagada. */
public class PrepareService extends Service {
    static final String ACTION_START = "com.claseclara.app.preparar.START";
    static final String ACTION_UPDATE = "com.claseclara.app.preparar.UPDATE";
    static final String EXTRA_DETALLE = "detalle";
    private static final String CHANNEL = "preparar";
    private static final int NOTIF_ID = 4105;
    private static volatile boolean activo = false;

    private PowerManager.WakeLock wakeLock;
    private String detalle = "Preparando la clase";

    static boolean activo() {
        return activo;
    }

    static void start(Context context, String detalle) {
        Intent intent = new Intent(context, PrepareService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_DETALLE, texto(detalle));
        ContextCompat.startForegroundService(context, intent);
    }

    static void actualizar(Context context, String detalle) {
        Intent intent = new Intent(context, PrepareService.class);
        intent.setAction(ACTION_UPDATE);
        intent.putExtra(EXTRA_DETALLE, texto(detalle));
        context.startService(intent);
    }

    static void dismiss(Context context) {
        context.stopService(new Intent(context, PrepareService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String incoming = intent != null ? intent.getStringExtra(EXTRA_DETALLE) : "";
        if (incoming != null && !incoming.isEmpty()) detalle = texto(incoming);
        holdWake();
        showOngoing();
        activo = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        activo = false;
        stopForeground(true);
        releaseWake();
        super.onDestroy();
    }

    private void showOngoing() {
        ensureChannel();
        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return;
            }
        } catch (RuntimeException ignored) {
            // Sigue con el aviso simple si el tipo de servicio no entra.
        }
        startForeground(NOTIF_ID, notification);
    }

    private Notification buildNotification() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(
                this,
                3,
                new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("ClaseClara")
                .setContentText(detalle)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(open);
        return builder.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "Preparar clase", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Sigue preparando la clase con la pantalla apagada");
        channel.setSound(null, null);
        channel.enableVibration(false);
        manager.createNotificationChannel(channel);
    }

    private void holdWake() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ClaseClara:preparar");
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

    private static String texto(String value) {
        String clean = String.valueOf(value == null ? "" : value).replaceAll("\\s+", " ").trim();
        if (clean.isEmpty()) return "Preparando la clase";
        if (clean.length() > 80) return clean.substring(0, 80);
        return clean;
    }
}

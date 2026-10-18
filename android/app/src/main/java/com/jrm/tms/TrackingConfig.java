package com.jrm.tms;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

// Ruta activa y credencial del dispositivo, guardadas para que el servicio se recupere solo (reinicio del teléfono,
// actualización del APK o cierre por el sistema) sin esperar a que el conductor abra el app.
final class TrackingConfig {
    static final String PREFS = "jrm_route_tracking";
    // Una ruta guardada hace más de este tiempo no se reanuda sola (pudo cerrarse con el teléfono apagado)
    static final long MAX_RESUME_AGE_MS = 20L * 60 * 60 * 1000;

    final String dispatchId;
    final String driverId;
    final String supabaseUrl;
    final String anonKey;
    final String deviceToken;
    final long savedAt;

    TrackingConfig(String dispatchId, String driverId, String supabaseUrl, String anonKey, String deviceToken, long savedAt) {
        this.dispatchId = dispatchId;
        this.driverId = driverId;
        this.supabaseUrl = supabaseUrl;
        this.anonKey = anonKey;
        this.deviceToken = deviceToken;
        this.savedAt = savedAt;
    }

    static TrackingConfig load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new TrackingConfig(prefs.getString("dispatch_id", null), prefs.getString("driver_id", null),
            prefs.getString("supabase_url", null), prefs.getString("anon_key", null), prefs.getString("device_token", null),
            prefs.getLong("saved_at", 0));
    }

    // Lo que trae el intent manda; lo que falta (APK nuevo con web anterior, reinicio del sistema) se toma de lo guardado
    static TrackingConfig fromIntent(Intent intent, TrackingConfig saved) {
        if (intent == null) return saved;
        return new TrackingConfig(pick(intent.getStringExtra("dispatch_id"), saved.dispatchId),
            pick(intent.getStringExtra("driver_id"), saved.driverId), pick(intent.getStringExtra("supabase_url"), saved.supabaseUrl),
            pick(intent.getStringExtra("anon_key"), saved.anonKey), pick(intent.getStringExtra("device_token"), saved.deviceToken),
            intent.hasExtra("dispatch_id") ? System.currentTimeMillis() : saved.savedAt);
    }

    private static String pick(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    boolean hasRoute() { return dispatchId != null && driverId != null; }

    boolean canSync() {
        return supabaseUrl != null && supabaseUrl.startsWith("https://") && anonKey != null && deviceToken != null
            && deviceToken.matches("[0-9a-f]{64}");
    }

    boolean resumable(long now) { return hasRoute() && savedAt > 0 && now - savedAt < MAX_RESUME_AGE_MS; }

    void save(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("dispatch_id", dispatchId).putString("driver_id", driverId)
            .putString("supabase_url", supabaseUrl).putString("anon_key", anonKey).putString("device_token", deviceToken)
            .putLong("saved_at", savedAt).apply();
    }

    // Fin de la ruta: se conserva la credencial para la próxima
    static void clearRoute(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("dispatch_id").remove("driver_id").remove("saved_at").apply();
    }

    // Cierre de sesión: no queda nada que permita subir datos en nombre del conductor
    static void clearAll(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }
}

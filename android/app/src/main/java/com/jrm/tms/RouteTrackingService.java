package com.jrm.tms;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

// Seguimiento de la ruta en primer plano. Registra los puntos en el teléfono y los sube por sí mismo con la credencial
// del dispositivo, aunque el app web esté congelado (pantalla apagada, app en segundo plano). Se recupera solo si el
// sistema lo cierra (START_STICKY), tras reiniciar el teléfono o actualizar el APK (BootReceiver).
public class RouteTrackingService extends Service implements LocationListener {
    static final String ACTION_STOP = "com.jrm.tms.STOP_ROUTE_TRACKING";
    private static final String CHANNEL_ID = "jrm_route_tracking";
    private static final long SYNC_SECONDS = 20;
    private static final long HEARTBEAT_MS = 60000;
    static final String ACTION_WATCHDOG = "com.jrm.tms.ROUTE_WATCHDOG";
    private static final String ALERT_CHANNEL_ID = "jrm_signal_alerts";
    private static final int ALERT_ID = 3102;
    private static final long WATCH_MS = 60000;
    static final long STALE_MS = 2 * 60000;
    private static final long REALERT_MS = 10 * 60000;
    private static final long WATCHDOG_MS = 5 * 60000;
    private static final long[] VIBRATION = { 0, 400, 200, 400, 200, 800 };

    private LocationManager locationManager;
    private FusedLocationProviderClient fused;
    private LocationCallback fusedCallback;
    private boolean platformListening;
    private RoutePointStore store;
    private volatile TrackingConfig config;
    private volatile Location lastLocation;
    private volatile boolean unauthorized;
    private volatile long lastReport;
    private ScheduledExecutorService sync;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ConnectivityManager.NetworkCallback networkCallback;
    private volatile long lastFixAt = System.currentTimeMillis();
    private long lastWatch, problemSince, lastAlertAt, lastLocationRestart;

    @Override public void onCreate() {
        super.onCreate();
        store = new RoutePointStore(this);
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            TrackingConfig.clearRoute(this);
            stopSelf();
            return START_NOT_STICKY;
        }
        TrackingConfig next = TrackingConfig.fromIntent(intent, TrackingConfig.load(this));
        if (!next.hasRoute()) { stopSelf(); return START_NOT_STICKY; }
        startForegroundNotice();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf(); return START_NOT_STICKY;
        }
        next.save(this);
        TrackingConfig previous = config;
        boolean routeChanged = previous == null || !next.dispatchId.equals(previous.dispatchId) || !next.driverId.equals(previous.driverId);
        if (previous == null || next.deviceToken == null || !next.deviceToken.equals(previous.deviceToken)) unauthorized = false;
        config = next;
        if (routeChanged || (fused == null && !platformListening)) startLocation();
        startSync();
        watchNetwork();
        scheduleWatchdog();
        return START_STICKY;
    }

    private void startForegroundNotice() {
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(
            new NotificationChannel(CHANNEL_ID, "Seguimiento de ruta JRM", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Ruta JRM en seguimiento")
            .setContentText("Registrando y enviando puntos GPS durante el recorrido")
            .setOngoing(true).setContentIntent(pending).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(3101, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(3101, notification);
    }

    // Ubicación de Google (GPS + Wi-Fi + antenas); sin Google Play Services, GPS y red del sistema
    private void startLocation() {
        stopLocation();
        lastFixAt = System.currentTimeMillis();
        try {
            fused = LocationServices.getFusedLocationProviderClient(this);
            LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5000)
                .setMinUpdateIntervalMillis(2000).build();
            fusedCallback = new LocationCallback() {
                @Override public void onLocationResult(LocationResult result) {
                    for (Location location : result.getLocations()) onLocationChanged(location);
                }
            };
            fused.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                .addOnFailureListener(error -> { fused = null; startPlatformLocation(); });
        } catch (RuntimeException | LinkageError error) {
            fused = null;
            startPlatformLocation();
        }
    }

    private void startPlatformLocation() {
        if (platformListening || locationManager == null) return;
        try {
            // Sin distancia mínima: detenido también llegan puntos, y el vigía no confunde "parado" con "sin GPS"
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 0, this);
            platformListening = true;
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 0, this);
            }
        } catch (SecurityException | IllegalArgumentException error) {
            if (!platformListening) stopSelf();
        }
    }

    private void stopLocation() {
        if (fused != null && fusedCallback != null) {
            try { fused.removeLocationUpdates(fusedCallback); } catch (RuntimeException ignored) { }
        }
        fused = null;
        fusedCallback = null;
        if (locationManager != null) locationManager.removeUpdates(this);
        platformListening = false;
    }

    @Override public void onLocationChanged(Location location) {
        lastLocation = location;
        lastFixAt = System.currentTimeMillis();
        TrackingConfig current = config;
        // La cola solo guarda puntos precisos (≤ 30 m) para los kilómetros; la presencia usa cualquier ubicación
        if (current != null && current.hasRoute()) store.add(current.dispatchId, current.driverId, location);
    }

    private void startSync() {
        if (sync != null) return;
        sync = Executors.newSingleThreadScheduledExecutor();
        sync.scheduleWithFixedDelay(this::syncOnce, 5, SYNC_SECONDS, TimeUnit.SECONDS);
    }

    private void syncOnce() {
        try {
            if (System.currentTimeMillis() - lastWatch >= WATCH_MS) watch();
            TrackingConfig current = config;
            if (current == null || !current.canSync() || unauthorized) return;
            // Hasta 10 lotes seguidos para ponerse al día tras un corte; si no hay puntos, solo el aviso cada minuto
            for (int round = 0; round < 10; round++) {
                int pending = store.count();
                if (pending == 0 && System.currentTimeMillis() - lastReport < HEARTBEAT_MS) return;
                NativeSync.Result result = NativeSync.run(store, current, clientInfo(pending), NativeSync.http());
                if (result == NativeSync.Result.UNAUTHORIZED) { unauthorized = true; return; }
                if (result != NativeSync.Result.OK) return;
                lastReport = System.currentTimeMillis();
                if (pending <= NativeSync.BATCH) return;
            }
        } catch (RuntimeException ignored) { }
    }

    // Qué impide que la ruta llegue al servidor; null si todo va bien. El orden da la causa más útil para el conductor.
    static String problem(boolean locationOn, long sinceFix, boolean online, int pending, long sinceReport, boolean blocked) {
        if (!locationOn) return "Ubicación apagada: actívala para registrar tu ruta";
        if (sinceFix > STALE_MS) return "Sin señal GPS: reintentando la ubicación";
        if (!online) return "Sin internet: " + pending + " punto(s) GPS guardados se enviarán solos al volver la red";
        if (blocked) return "Abre la app JRM para reanudar el envío de tu ruta";
        if (pending > 0 && sinceReport > STALE_MS) return pending + " punto(s) GPS sin enviar: reintentando el envío";
        return null;
    }

    // Vigía de cada minuto: avisa al conductor si la ruta deja de llegar y reintenta por su cuenta
    private void watch() {
        long now = System.currentTimeMillis();
        lastWatch = now;
        scheduleWatchdog();
        boolean locationOn = locationManager == null || LocationManagerCompat.isLocationEnabled(locationManager);
        long sinceFix = now - lastFixAt;
        if (locationOn && sinceFix > STALE_MS && now - lastLocationRestart > STALE_MS) {
            lastLocationRestart = now;
            main.post(this::startLocation);
        }
        TrackingConfig current = config;
        // Sin credencial nativa los puntos los sube la web: el servicio no puede juzgar si se están enviando
        int pending = current != null && current.canSync() ? store.count() : 0;
        String problem = problem(locationOn, sinceFix, !"none".equals(networkType()), pending, now - lastReport, unauthorized);
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (problem == null) {
            if (problemSince != 0 && notifications != null) notifications.cancel(ALERT_ID);
            problemSince = 0;
            lastAlertAt = 0;
            return;
        }
        if (problemSince == 0) problemSince = now;
        // La ubicación apagada se avisa de inmediato; lo demás, si dura más de 2 minutos (los cortes breves no molestan)
        if ((locationOn && now - problemSince < STALE_MS) || now - lastAlertAt < REALERT_MS || notifications == null) return;
        lastAlertAt = now;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(ALERT_CHANNEL_ID, "Alertas de señal JRM", NotificationManager.IMPORTANCE_HIGH);
            channel.enableVibration(true);
            channel.setVibrationPattern(VIBRATION);
            notifications.createNotificationChannel(channel);
        }
        Intent open = locationOn ? new Intent(this, MainActivity.class) : new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        notifications.notify(ALERT_ID, new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("JRM · Tu ruta no se está enviando")
            .setContentText(problem)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(problem))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVibrate(VIBRATION)
            .setDefaults(NotificationCompat.DEFAULT_SOUND)
            .setAutoCancel(true).setContentIntent(tap).build());
    }

    // Al volver la red se envía en el acto, sin esperar la siguiente vuelta
    private void watchNetwork() {
        if (networkCallback != null) return;
        ConnectivityManager connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                ScheduledExecutorService current = sync;
                if (current != null) try { current.execute(RouteTrackingService.this::syncOnce); } catch (RuntimeException ignored) { }
            }
        };
        try { connectivity.registerDefaultNetworkCallback(networkCallback); } catch (RuntimeException error) { networkCallback = null; }
    }

    // Si Android cierra el servicio, esta alarma lo revive (BootReceiver); mientras vive, el vigía la pospone cada minuto
    private void scheduleWatchdog() {
        AlarmManager alarms = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        Intent wake = new Intent(this, BootReceiver.class).setAction(ACTION_WATCHDOG);
        PendingIntent pending = PendingIntent.getBroadcast(this, 0, wake, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + WATCHDOG_MS, pending);
    }

    JSONObject clientInfo(int pending) {
        JSONObject client = new JSONObject();
        try {
            BatteryManager battery = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
            int level = battery == null ? -1 : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if (level >= 0 && level <= 100) client.put("battery", level / 100.0);
            Intent status = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (status != null) {
                int plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                client.put("charging", plugged != 0);
            }
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                client.put("power_save", power.isPowerSaveMode());
                client.put("battery_exempt", power.isIgnoringBatteryOptimizations(getPackageName()));
            }
            String network = networkType();
            client.put("online", !"none".equals(network));
            client.put("network", network);
            client.put("platform", "android-native");
            client.put("pending_points", pending);
            client.put("device", Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE);
            client.put("app_version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
            Location location = lastLocation;
            client.put("gps_state", location == null ? "checking" : "active");
        } catch (JSONException | PackageManager.NameNotFoundException | RuntimeException ignored) { }
        return client;
    }

    private String networkType() {
        ConnectivityManager connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) return "none";
        Network network = connectivity.getActiveNetwork();
        NetworkCapabilities caps = network == null ? null : connectivity.getNetworkCapabilities(network);
        if (caps == null) return "none";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "movil";
        return "otra";
    }

    @Override public void onDestroy() {
        stopLocation();
        if (networkCallback != null) {
            ConnectivityManager connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            try { if (connectivity != null) connectivity.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
            networkCallback = null;
        }
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (notifications != null) notifications.cancel(ALERT_ID);
        if (sync != null) sync.shutdownNow();
        sync = null;
        if (store != null) store.close();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

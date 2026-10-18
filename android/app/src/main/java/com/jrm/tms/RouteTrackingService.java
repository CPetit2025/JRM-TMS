package com.jrm.tms;

import android.Manifest;
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
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
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
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 1, this);
            platformListening = true;
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 5, this);
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
        if (sync != null) sync.shutdownNow();
        sync = null;
        if (store != null) store.close();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

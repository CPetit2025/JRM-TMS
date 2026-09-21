package com.jrm.tms;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

public class RouteTrackingService extends Service implements LocationListener {
    static final String ACTION_STOP = "com.jrm.tms.STOP_ROUTE_TRACKING";
    private static final String CHANNEL_ID = "jrm_route_tracking";
    private LocationManager locationManager;
    private RoutePointStore store;
    private String dispatchId;
    private String driverId;

    @Override public void onCreate() {
        super.onCreate();
        store = new RoutePointStore(this);
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String nextDispatch = intent.getStringExtra("dispatch_id");
        String nextDriver = intent.getStringExtra("driver_id");
        if (nextDispatch == null || nextDriver == null) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(
            new NotificationChannel(CHANNEL_ID, "Seguimiento de ruta JRM", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Ruta JRM en seguimiento")
            .setContentText("Registrando puntos GPS durante el recorrido")
            .setOngoing(true).setContentIntent(pending).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(3101, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(3101, notification);
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf(); return START_NOT_STICKY;
        }
        if (!nextDispatch.equals(dispatchId) || !nextDriver.equals(driverId)) {
            locationManager.removeUpdates(this);
            dispatchId = nextDispatch;
            driverId = nextDriver;
            try { locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 1, this); }
            catch (SecurityException | IllegalArgumentException e) { stopSelf(); }
        }
        return START_NOT_STICKY;
    }

    @Override public void onLocationChanged(Location location) {
        if (dispatchId != null && driverId != null) store.add(dispatchId, driverId, location);
    }
    @Override public void onDestroy() {
        if (locationManager != null) locationManager.removeUpdates(this);
        if (store != null) store.close();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}

package com.jrm.tms;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;

// Reanuda el seguimiento de una ruta en curso tras reiniciar el teléfono o actualizar el APK. El servicio toma la ruta
// y la credencial guardadas; una ruta guardada hace demasiado tiempo no se reanuda (pudo cerrarse con el teléfono apagado).
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        if (!TrackingConfig.load(context).resumable(System.currentTimeMillis())) return;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, RouteTrackingService.class));
        } catch (RuntimeException ignored) {
            // Android puede negar el inicio en segundo plano: el app lo retoma al abrirse
        }
    }
}

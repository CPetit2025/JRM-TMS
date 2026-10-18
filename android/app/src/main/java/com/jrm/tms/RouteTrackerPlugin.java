package com.jrm.tms;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import androidx.core.content.ContextCompat;
import java.util.UUID;

@CapacitorPlugin(name = "RouteTracker", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION })
})
public class RouteTrackerPlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) {
        String dispatchId = call.getString("dispatchId");
        String driverId = call.getString("driverId");
        try { UUID.fromString(dispatchId); UUID.fromString(driverId); }
        catch (Exception ex) { call.reject("Identificador de ruta inválido"); return; }
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionResult");
            return;
        }
        begin(call, dispatchId, driverId);
    }

    @PermissionCallback private void locationPermissionResult(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Permiso GPS denegado"); return;
        }
        begin(call, call.getString("dispatchId"), call.getString("driverId"));
    }

    private void begin(PluginCall call, String dispatchId, String driverId) {
        Intent intent = new Intent(getContext(), RouteTrackingService.class);
        intent.putExtra("dispatch_id", dispatchId);
        intent.putExtra("driver_id", driverId);
        // Credencial del dispositivo para que el servicio suba los puntos por sí mismo (opcional: web anterior)
        String url = call.getString("supabaseUrl"), key = call.getString("anonKey"), token = call.getString("deviceToken");
        if (url != null && url.startsWith("https://") && key != null && token != null && token.matches("[0-9a-f]{64}")) {
            intent.putExtra("supabase_url", url);
            intent.putExtra("anon_key", key);
            intent.putExtra("device_token", token);
        }
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception ex) { call.reject("No se pudo iniciar seguimiento GPS", ex); }
    }

    @PluginMethod public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RouteTrackingService.class));
        TrackingConfig.clearRoute(getContext());
        call.resolve();
    }

    // Cierre de sesión: detiene el seguimiento y borra la credencial del dispositivo
    @PluginMethod public void forget(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RouteTrackingService.class));
        TrackingConfig.clearAll(getContext());
        call.resolve();
    }

    // Estado para guiar al conductor: exención de optimización de batería, ahorro activo y marca del teléfono
    @PluginMethod public void batteryStatus(PluginCall call) {
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject result = new JSObject();
        result.put("exempt", power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        result.put("powerSave", power != null && power.isPowerSaveMode());
        result.put("manufacturer", Build.MANUFACTURER);
        result.put("credential", TrackingConfig.load(getContext()).canSync());
        call.resolve(result);
    }

    // Pide al sistema que el app no sea suspendido por la optimización de batería (el usuario confirma en Android)
    @PluginMethod public void requestBatteryExemption(PluginCall call) {
        String pkg = getContext().getPackageName();
        Intent request = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
        try {
            getActivity().startActivity(request);
        } catch (ActivityNotFoundException | SecurityException error) {
            try { getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
            catch (ActivityNotFoundException | SecurityException ignored) {
                call.reject("Abra Ajustes > Batería y quite la optimización para JRM"); return;
            }
        }
        call.resolve();
    }

    // Ajustes del app (permiso de ubicación «Permitir siempre», inicio automático en algunas marcas)
    @PluginMethod public void openAppSettings(PluginCall call) {
        Intent settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        try { getActivity().startActivity(settings); call.resolve(); }
        catch (ActivityNotFoundException error) { call.reject("No se pudieron abrir los ajustes del app"); }
    }

    @PluginMethod public void pending(PluginCall call) {
        try (RoutePointStore store = new RoutePointStore(getContext())) {
            JSObject result = new JSObject();
            result.put("points", store.pending());
            call.resolve(result);
        }
    }

    @PluginMethod public void acknowledge(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids == null) { call.reject("Faltan identificadores"); return; }
        try (RoutePointStore store = new RoutePointStore(getContext())) {
            store.acknowledge(ids);
            call.resolve();
        }
    }
}

package com.jrm.tms;

import android.Manifest;
import android.content.Intent;
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
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception ex) { call.reject("No se pudo iniciar seguimiento GPS", ex); }
    }

    @PluginMethod public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RouteTrackingService.class));
        call.resolve();
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

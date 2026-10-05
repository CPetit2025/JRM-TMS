package com.jrm.tms;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Device-local access lock; never stores passwords, PINs or auth tokens. */
@CapacitorPlugin(name = "BiometricLock")
public class BiometricPlugin extends Plugin {
    @PluginMethod public void status(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        JSObject result = new JSObject();
        result.put("available", activity.biometricAvailable());
        result.put("enabled", activity.biometricEnabled());
        call.resolve(result);
    }

    @PluginMethod public void configure(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("Falta indicar la opción biométrica"); return; }
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).configureBiometrics(enabled,
            () -> call.resolve(), message -> call.reject(message)));
    }

    // Explicit logout still requires local authentication if the app is locked.
    @PluginMethod public void clear(PluginCall call) {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).clearBiometrics(
            () -> call.resolve(), message -> call.reject(message)));
    }
}

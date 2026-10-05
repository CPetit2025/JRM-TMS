package com.jrm.tms;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.function.Consumer;

public class MainActivity extends BridgeActivity {
    private LinearLayout lockScreen;
    private boolean locked = true;
    private boolean foreground = false;
    private TextView lockMessage;
    private boolean prompting = false;

    @Override protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(RouteTrackerPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(BiometricPlugin.class);
        super.onCreate(savedInstanceState);
        // Prevent snapshots of authenticated content in Android's task switcher.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        lockScreen = new LinearLayout(this);
        lockScreen.setOrientation(LinearLayout.VERTICAL);
        lockScreen.setGravity(Gravity.CENTER);
        lockScreen.setPadding(40, 40, 40, 40);
        lockScreen.setBackgroundColor(Color.rgb(0, 40, 85));
        lockScreen.setClickable(true);
        TextView title = new TextView(this);
        title.setText("JRM · Sesión protegida\nDesbloquea para continuar");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        lockScreen.addView(title);
        lockMessage = title;
        Button unlock = new Button(this);
        unlock.setText("Desbloquear");
        unlock.setOnClickListener(view -> unlock());
        lockScreen.addView(unlock);
        Button login = new Button(this);
        login.setText("Cerrar sesión e ingresar con contraseña");
        login.setOnClickListener(view -> new androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("¿Cerrar la sesión guardada?")
            .setMessage("Tendrás que ingresar nuevamente con tu usuario y contraseña. Se detendrá el seguimiento GPS.")
            .setNegativeButton("Cancelar", null)
            .setPositiveButton("Cerrar sesión", (dialog, which) -> resetSession())
            .show());
        lockScreen.addView(login);
        addContentView(lockScreen, new android.view.ViewGroup.LayoutParams(-1, -1));
        locked = biometricEnabled();
        showLock();
    }

    public boolean biometricEnabled() {
        return getSharedPreferences("jrm_security", MODE_PRIVATE).getBoolean("biometric", false);
    }

    public boolean biometricAvailable() {
        return BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private void showLock() {
        if (lockScreen == null) return;
        lockScreen.setVisibility(locked ? View.VISIBLE : View.GONE);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setVisibility(locked ? View.INVISIBLE : View.VISIBLE);
        }
    }

    private void authenticate(Runnable success, Consumer<String> failure, boolean enrolling) {
        if (prompting) { failure.accept("Ya hay una verificación en curso"); return; }
        prompting = true;
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this),
            new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    prompting = false;
                    success.run();
                }
                @Override public void onAuthenticationError(int code, CharSequence message) {
                    prompting = false;
                    failure.accept(message.toString());
                }
                // A non-matching fingerprint leaves the native dialog open for another attempt.
            });
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG;
        // Enabling requires biometrics; Android 11+ also offers the device PIN to recover access.
        if (!enrolling && Build.VERSION.SDK_INT >= 30) {
            authenticators |= BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Acceso seguro a JRM")
            .setSubtitle("Verifica tu identidad para continuar")
            .setAllowedAuthenticators(authenticators);
        if (enrolling || Build.VERSION.SDK_INT < 30) info.setNegativeButtonText("Cancelar");
        prompt.authenticate(info.build());
    }

    private void unlock() {
        if (!locked || prompting) return;
        authenticate(() -> { locked = !foreground; showLock(); }, message -> lockMessage.setText("Sesión protegida\n" + message + "\nPuedes reintentar o ingresar con contraseña."), false);
    }

    public void configureBiometrics(boolean enabled, Runnable success, Consumer<String> failure) {
        if (locked || !foreground) { failure.accept("Desbloquea primero la app"); return; }
        if (enabled && !biometricAvailable()) {
            failure.accept("Configura una huella o biometría segura en los ajustes del dispositivo");
            return;
        }
        authenticate(() -> {
            if (!foreground) { failure.accept("Vuelve a la app para cambiar la opción"); return; }
            getSharedPreferences("jrm_security", MODE_PRIVATE).edit().putBoolean("biometric", enabled).apply();
            success.run();
        }, failure, enabled);
    }

    public void clearBiometrics(Runnable success, Consumer<String> failure) {
        if (locked || !foreground) { failure.accept("Desbloquea primero la app"); return; }
        getSharedPreferences("jrm_security", MODE_PRIVATE).edit().remove("biometric").apply();
        success.run();
    }

    private void resetSession() {
        if (prompting) return;
        // Keep the WebView hidden until all auth cookies and local caches have been removed.
        locked = true;
        showLock();
        // Stop the page (and its token-refresh timers) before clearing persistent cookies.
        bridge.getWebView().evaluateJavascript("localStorage.clear();sessionStorage.clear();", result -> {
            bridge.getWebView().loadUrl("about:blank");
            android.webkit.CookieManager.getInstance().removeAllCookies(removed -> {
                android.webkit.CookieManager.getInstance().flush();
                android.webkit.WebStorage.getInstance().deleteAllData();
                stopService(new android.content.Intent(this, RouteTrackingService.class));
                getSharedPreferences("jrm_security", MODE_PRIVATE).edit().remove("biometric").commit();
                recreate();
            });
        });
    }

    @Override public void onPause() {
        foreground = false;
        android.webkit.CookieManager.getInstance().flush();
        if (biometricEnabled()) { locked = true; showLock(); }
        super.onPause();
    }

    @Override public void onResume() {
        super.onResume();
        foreground = true;
        if (lockScreen != null && locked) { showLock(); unlock(); }
    }
}

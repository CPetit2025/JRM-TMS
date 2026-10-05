package com.jrm.tms;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.webkit.ServiceWorkerController;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerWebSettings;
import android.view.View;
import android.view.WindowManager;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowWebView;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30, shadows = BiometricLockTest.ServiceWorkerShadow.class)
public class BiometricLockTest {
    // Robolectric has no Chromium service-worker provider. Substitute only that unrelated
    // platform service; the real MainActivity, native overlay and lifecycle run unchanged.
    @Implements(ServiceWorkerController.class)
    public static class ServiceWorkerShadow {
        @Implementation protected static ServiceWorkerController getInstance() {
            return new ServiceWorkerController() {
                @Override public ServiceWorkerWebSettings getServiceWorkerWebSettings() { return null; }
                @Override public void setServiceWorkerClient(ServiceWorkerClient client) {}
            };
        }
    }

    @Before public void reset() {
        PackageInfo webView = new PackageInfo();
        webView.packageName = "com.google.android.webview";
        webView.versionName = "145.0.0";
        ShadowWebView.setCurrentWebViewPackage(webView);
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("jrm_security", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test public void existingBiometricPreferenceHidesWebViewBeforeAuthentication() {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("jrm_security", Context.MODE_PRIVATE).edit().putBoolean("biometric", true).commit();
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            assertEquals(View.INVISIBLE, activity.getBridge().getWebView().getVisibility());
            assertTrue(activity.biometricEnabled());
            final boolean[] rejected = {false};
            activity.clearBiometrics(() -> fail("Locked app cannot bypass biometrics"), message -> rejected[0] = true);
            assertTrue(rejected[0]);
            assertTrue(activity.biometricEnabled());
        }
    }

    @Test public void noBiometricPreferenceLeavesLoginAccessibleAndSecuresSnapshots() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            assertEquals(View.VISIBLE, activity.getBridge().getWebView().getVisibility());
            assertFalse(activity.biometricEnabled());
            assertTrue((activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0);
        }
    }

    @Test public void leavingAuthenticatedAppLocksItWithoutClearingPreference() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup()) {
            MainActivity activity = controller.get();
            activity.getSharedPreferences("jrm_security", Context.MODE_PRIVATE).edit().putBoolean("biometric", true).commit();
            controller.pause();
            assertEquals(View.INVISIBLE, activity.getBridge().getWebView().getVisibility());
            assertTrue(activity.biometricEnabled());
        }
    }
}

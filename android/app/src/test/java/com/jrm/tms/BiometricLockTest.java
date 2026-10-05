package com.jrm.tms;

import static org.junit.Assert.*;
import android.content.Context;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class BiometricLockTest {
    @Before public void reset() {
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

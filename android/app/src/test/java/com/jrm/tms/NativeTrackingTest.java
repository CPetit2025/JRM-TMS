package com.jrm.tms;

import static org.junit.Assert.*;
import android.Manifest;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import androidx.test.core.app.ApplicationProvider;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class NativeTrackingTest {
    private static final String TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String DISPATCH = "11111111-1111-4111-8111-111111111111";
    private static final String DRIVER = "22222222-2222-4222-8222-222222222222";
    private Context context;
    private RoutePointStore store;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        TrackingConfig.clearAll(context);
        context.deleteDatabase("route_points.db");
        store = new RoutePointStore(context);
    }

    private void addPoint(long time, float accuracy) {
        Location location = new Location("gps");
        location.setLatitude(-12.05);
        location.setLongitude(-77.04);
        location.setAccuracy(accuracy);
        location.setTime(time);
        store.add(DISPATCH, DRIVER, location);
    }

    private TrackingConfig config() {
        return new TrackingConfig(DISPATCH, DRIVER, "https://example.supabase.co/", "anon-key", TOKEN, System.currentTimeMillis());
    }

    @Test public void syncSendsBatchWithTokenAndRemovesAcceptedAndRejected() throws Exception {
        addPoint(1000, 8);
        addPoint(2000, 12);
        addPoint(3000, 80); // impreciso: no entra a la cola de kilómetros
        assertEquals(2, store.count());
        JSONArray pending = store.pendingBatch(10);
        String first = pending.getJSONObject(0).getString("id"), second = pending.getJSONObject(1).getString("id");
        List<String> urls = new ArrayList<>();
        List<String> bodies = new ArrayList<>();
        String reply = new JSONObject().put("success", true)
            .put("accepted", new JSONArray().put(first)).put("rejected", new JSONArray().put(second)).toString();
        NativeSync.Result result = NativeSync.run(store, config(), new JSONObject().put("battery", 0.5), (url, key, body) -> {
            urls.add(url); bodies.add(body);
            assertEquals("anon-key", key);
            return new NativeSync.Response(200, reply);
        });
        assertEquals(NativeSync.Result.OK, result);
        assertEquals("https://example.supabase.co/rest/v1/rpc/native_tracking_sync", urls.get(0));
        JSONObject sent = new JSONObject(bodies.get(0));
        assertEquals(TOKEN, sent.getString("p_token"));
        assertEquals(2, sent.getJSONArray("p_points").length());
        assertEquals(0.5, sent.getJSONObject("p_client").getDouble("battery"), 0.001);
        assertEquals(0, store.count());
    }

    @Test public void revokedCredentialOrNetworkFailureKeepsPoints() {
        addPoint(1000, 8);
        assertEquals(NativeSync.Result.UNAUTHORIZED,
            NativeSync.run(store, config(), new JSONObject(), (url, key, body) -> new NativeSync.Response(401, "{}")));
        assertEquals(NativeSync.Result.UNAUTHORIZED, NativeSync.run(store, config(), new JSONObject(),
            (url, key, body) -> new NativeSync.Response(200, "{\"success\":false,\"error\":\"Dispositivo no autorizado\"}")));
        assertEquals(NativeSync.Result.FAILED, NativeSync.run(store, config(), new JSONObject(),
            (url, key, body) -> { throw new IOException("sin señal"); }));
        assertEquals(NativeSync.Result.FAILED,
            NativeSync.run(store, config(), new JSONObject(), (url, key, body) -> new NativeSync.Response(503, "")));
        assertEquals(1, store.count());
    }

    @Test public void configKeepsCredentialAcrossRoutesAndClearsOnLogout() {
        Intent start = new Intent().putExtra("dispatch_id", DISPATCH).putExtra("driver_id", DRIVER)
            .putExtra("supabase_url", "https://example.supabase.co").putExtra("anon_key", "anon-key").putExtra("device_token", TOKEN);
        TrackingConfig saved = TrackingConfig.fromIntent(start, TrackingConfig.load(context));
        saved.save(context);
        assertTrue(TrackingConfig.load(context).canSync());
        assertTrue(TrackingConfig.load(context).resumable(System.currentTimeMillis()));
        // Reinicio del sistema (intent vacío): se recupera la ruta y la credencial guardadas
        TrackingConfig restored = TrackingConfig.fromIntent(null, TrackingConfig.load(context));
        assertEquals(DISPATCH, restored.dispatchId);
        assertEquals(TOKEN, restored.deviceToken);
        // Web anterior sin credencial: conserva la guardada
        TrackingConfig legacy = TrackingConfig.fromIntent(new Intent().putExtra("dispatch_id", DISPATCH).putExtra("driver_id", DRIVER), TrackingConfig.load(context));
        assertTrue(legacy.canSync());
        TrackingConfig.clearRoute(context);
        assertFalse(TrackingConfig.load(context).hasRoute());
        assertTrue(TrackingConfig.load(context).canSync());
        TrackingConfig.clearAll(context);
        assertFalse(TrackingConfig.load(context).canSync());
        assertFalse(new TrackingConfig(DISPATCH, DRIVER, "http://inseguro", "k", TOKEN, 1).canSync());
        assertFalse(new TrackingConfig(DISPATCH, DRIVER, "https://ok", "k", "corto", 1).canSync());
        assertFalse(new TrackingConfig(DISPATCH, DRIVER, null, null, null, 1).resumable(TrackingConfig.MAX_RESUME_AGE_MS + 2));
    }

    @Test public void bootResumesOnlyRecentRouteWithLocationPermission() {
        Application app = ApplicationProvider.getApplicationContext();
        Shadows.shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION);
        new TrackingConfig(DISPATCH, DRIVER, "https://example.supabase.co", "anon-key", TOKEN, System.currentTimeMillis()).save(context);
        new BootReceiver().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
        Intent started = Shadows.shadowOf(app).getNextStartedService();
        assertNotNull(started);
        assertEquals(RouteTrackingService.class.getName(), started.getComponent().getClassName());
        // Ruta guardada hace más de 20 h: no se reanuda sola
        new TrackingConfig(DISPATCH, DRIVER, "https://example.supabase.co", "anon-key", TOKEN, 1).save(context);
        new BootReceiver().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
        assertNull(Shadows.shadowOf(app).getNextStartedService());
        // Otro evento del sistema: no hace nada
        new TrackingConfig(DISPATCH, DRIVER, "https://example.supabase.co", "anon-key", TOKEN, System.currentTimeMillis()).save(context);
        new BootReceiver().onReceive(context, new Intent(Intent.ACTION_SCREEN_ON));
        assertNull(Shadows.shadowOf(app).getNextStartedService());
    }
}

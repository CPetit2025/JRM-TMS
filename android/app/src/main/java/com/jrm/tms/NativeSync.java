package com.jrm.tms;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// Subida del servicio nativo: lotes de puntos GPS y aviso de conexión con la credencial del dispositivo
// (native_tracking_sync). El servidor devuelve los puntos aceptados y los rechazados; ambos salen de la cola.
final class NativeSync {
    static final int BATCH = 200;
    enum Result { OK, UNAUTHORIZED, FAILED }

    static final class Response {
        final int status;
        final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }

    interface Transport { Response post(String url, String apiKey, String body) throws IOException; }

    static Result run(RoutePointStore store, TrackingConfig config, JSONObject client, Transport transport) {
        try {
            JSONArray points = store.pendingBatch(BATCH);
            JSONObject body = new JSONObject();
            body.put("p_token", config.deviceToken);
            body.put("p_points", points);
            body.put("p_client", client);
            Response response = transport.post(config.supabaseUrl.replaceAll("/+$", "") + "/rest/v1/rpc/native_tracking_sync",
                config.anonKey, body.toString());
            if (response.status == 401 || response.status == 403) return Result.UNAUTHORIZED;
            if (response.status < 200 || response.status >= 300) return Result.FAILED;
            JSONObject result = new JSONObject(response.body);
            if (!result.optBoolean("success", false)) {
                return "Dispositivo no autorizado".equals(result.optString("error")) ? Result.UNAUTHORIZED : Result.FAILED;
            }
            JSONArray done = new JSONArray();
            JSONArray accepted = result.optJSONArray("accepted");
            JSONArray rejected = result.optJSONArray("rejected");
            if (accepted != null) for (int i = 0; i < accepted.length(); i++) done.put(accepted.optString(i));
            if (rejected != null) for (int i = 0; i < rejected.length(); i++) done.put(rejected.optString(i));
            store.acknowledge(done);
            return Result.OK;
        } catch (IOException | JSONException | RuntimeException error) {
            return Result.FAILED;
        }
    }

    static Transport http() {
        return (url, apiKey, body) -> {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            try {
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("apikey", apiKey);
                connection.setRequestProperty("Authorization", "Bearer " + apiKey);
                try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                int status = connection.getResponseCode();
                InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                return new Response(status, in == null ? "" : read(in));
            } finally { connection.disconnect(); }
        };
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }
}

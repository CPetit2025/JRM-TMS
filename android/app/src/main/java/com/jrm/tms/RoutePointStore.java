package com.jrm.tms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import java.util.UUID;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import android.location.Location;

class RoutePointStore extends SQLiteOpenHelper {
    RoutePointStore(Context context) { super(context, "route_points.db", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE points (id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, driver_id TEXT NOT NULL, recorded_at TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy_m REAL NOT NULL, speed_mps REAL)");
        db.execSQL("CREATE INDEX points_time ON points(recorded_at)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    void add(String dispatchId, String driverId, Location location) {
        if (!location.hasAccuracy() || location.getAccuracy() > 30 || location.getAccuracy() < 0) return;
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        ContentValues row = new ContentValues();
        row.put("id", UUID.randomUUID().toString());
        row.put("dispatch_id", dispatchId);
        row.put("driver_id", driverId);
        row.put("recorded_at", format.format(new Date(location.getTime())));
        row.put("latitude", location.getLatitude());
        row.put("longitude", location.getLongitude());
        row.put("accuracy_m", location.getAccuracy());
        if (location.hasSpeed()) row.put("speed_mps", location.getSpeed());
        getWritableDatabase().insert("points", null, row);
    }

    JSArray pending() {
        JSArray result = new JSArray();
        try (Cursor rows = getReadableDatabase().rawQuery(
            "SELECT id,dispatch_id,driver_id,recorded_at,latitude,longitude,accuracy_m,speed_mps FROM points ORDER BY recorded_at,id LIMIT 100", null)) {
            while (rows.moveToNext()) {
                JSObject point = new JSObject();
                point.put("id", rows.getString(0));
                point.put("dispatch_id", rows.getString(1));
                point.put("driver_id", rows.getString(2));
                point.put("recorded_at", rows.getString(3));
                point.put("latitude", rows.getDouble(4));
                point.put("longitude", rows.getDouble(5));
                point.put("accuracy_m", rows.getDouble(6));
                if (!rows.isNull(7)) point.put("speed_mps", rows.getDouble(7));
                result.put(point);
            }
        }
        return result;
    }

    void acknowledge(JSONArray ids) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int i = 0; i < ids.length(); i++) {
                String id = ids.optString(i, "");
                if (!id.isEmpty()) db.delete("points", "id=?", new String[] { id });
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
}

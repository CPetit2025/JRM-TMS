package com.jrm.tms;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private File updateFile() {
        return new File(new File(getContext().getCacheDir(), "updates"), "jrm-tms-update.apk");
    }

    @PluginMethod
    public void download(PluginCall call) {
        String address = call.getString("url");
        String expectedHash = call.getString("sha256");
        if (address == null || expectedHash == null || !expectedHash.matches("[0-9a-fA-F]{64}")) {
            call.reject("Metadatos de actualización inválidos"); return;
        }
        getBridge().execute(() -> {
            File temporary = new File(updateFile().getParentFile(), "download.tmp");
            HttpURLConnection connection = null;
            try {
                URL url = new URL(address);
                if (!"https".equalsIgnoreCase(url.getProtocol())) throw new Exception("Se requiere HTTPS");
                updateFile().getParentFile().mkdirs();
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(45000);
                int code = connection.getResponseCode();
                if (code != 200) throw new Exception("Descarga HTTP " + code);
                if (connection.getContentLengthLong() > 150L * 1024L * 1024L) throw new Exception("APK demasiado grande");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long size = 0;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temporary)) {
                    byte[] chunk = new byte[8192];
                    int count;
                    while ((count = input.read(chunk)) != -1) {
                        size += count;
                        if (size > 150L * 1024L * 1024L) throw new Exception("APK demasiado grande");
                        digest.update(chunk, 0, count);
                        output.write(chunk, 0, count);
                    }
                }
                StringBuilder actual = new StringBuilder();
                for (byte value : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", value & 0xff));
                if (!actual.toString().equalsIgnoreCase(expectedHash)) throw new Exception("SHA-256 no coincide");
                verifyPackage(temporary);
                File target = updateFile();
                if (target.exists() && !target.delete()) throw new Exception("No se pudo reemplazar la descarga anterior");
                if (!temporary.renameTo(target)) throw new Exception("No se pudo guardar el APK");
                getContext().getSharedPreferences("jrm-updates", 0).edit()
                    .putString("sha256", expectedHash.toLowerCase(Locale.ROOT)).apply();
                JSObject result = new JSObject();
                result.put("ready", true);
                result.put("bytes", size);
                call.resolve(result);
            } catch (Exception error) {
                temporary.delete();
                call.reject("No se pudo preparar la actualización: " + error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        try {
            File apk = updateFile();
            if (!apk.exists()) throw new Exception("No hay APK descargado");
            String expected = getContext().getSharedPreferences("jrm-updates", 0).getString("sha256", "");
            if (!sha256(apk).equals(expected)) throw new Exception("El APK descargado cambió");
            verifyPackage(apk);
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(settings);
                call.reject("Autoriza la instalación desde JRM-TMS y vuelve a pulsar Instalar");
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo abrir el instalador: " + error.getMessage());
        }
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] bytes = new byte[8192]; int count;
            while ((count = input.read(bytes)) != -1) digest.update(bytes, 0, count);
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    @SuppressWarnings("deprecation")
    private void verifyPackage(File apk) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flag = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flag);
        PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flag);
        if (archive == null || !getContext().getPackageName().equals(archive.packageName))
            throw new Exception("El paquete no pertenece a JRM-TMS");
        long archiveCode = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
        long installedCode = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
        if (archiveCode <= installedCode) throw new Exception("El build no es más reciente");
        Signature[] newSigners = Build.VERSION.SDK_INT >= 28
            ? archive.signingInfo.getApkContentsSigners() : archive.signatures;
        Signature[] oldSigners = Build.VERSION.SDK_INT >= 28
            ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
        if (newSigners == null || oldSigners == null || newSigners.length != oldSigners.length)
            throw new Exception("Firma de APK inválida");
        for (int i = 0; i < newSigners.length; i++) {
            if (!Arrays.equals(newSigners[i].toByteArray(), oldSigners[i].toByteArray()))
                throw new Exception("La firma no coincide con la aplicación instalada");
        }
    }
}

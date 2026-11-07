package com.jrm.tms;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;

@CapacitorPlugin(name = "WarehouseBarcodeScanner")
public class WarehouseBarcodeScannerPlugin extends Plugin {
    @PluginMethod public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_CODE_128,
                com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE,
                com.google.mlkit.vision.barcode.common.Barcode.FORMAT_EAN_13,
                com.google.mlkit.vision.barcode.common.Barcode.FORMAT_EAN_8)
            .enableAutoZoom()
            .build();
        GmsBarcodeScanning.getClient(getContext(), options).startScan()
            .addOnSuccessListener(barcode -> {
                if (barcode == null || barcode.getRawValue() == null) {
                    call.reject("No se detectó un código");
                    return;
                }
                JSObject result = new JSObject();
                result.put("rawValue", barcode.getRawValue());
                result.put("format", barcode.getFormat());
                call.resolve(result);
            })
            .addOnCanceledListener(() -> call.reject("Lectura cancelada"))
            .addOnFailureListener(error -> call.reject("No se pudo iniciar el escáner ML Kit", error));
    }
}

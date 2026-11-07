package com.jrm.tms;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class WarehouseMainActivity extends BridgeActivity {
    @Override protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(WarehouseBarcodeScannerPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
}

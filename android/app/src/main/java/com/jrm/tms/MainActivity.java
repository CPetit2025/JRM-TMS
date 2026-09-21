package com.jrm.tms;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(RouteTrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

package com.desk.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 「停止」 on the "机器人可以操作这部手机" notice (1.4.0): turns the service off. Not exported. */
public class PhoneAgentStopReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!PhoneAgentService.ACTION_STOP.equals(intent.getAction())) return;
        PhoneAgentService service = PhoneAgentService.instance;
        if (service != null) service.stopByHuman();
    }
}

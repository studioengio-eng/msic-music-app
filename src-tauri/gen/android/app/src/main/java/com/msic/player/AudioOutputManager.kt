package com.msic.player

import android.Manifest
import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

object AudioOutputManager {
    private const val TAG = "AudioOutputManager"

    data class AudioDevice(
        val name: String,
        val address: String = "",
        val type: DeviceType,
        val isActive: Boolean = false
    )

    enum class DeviceType {
        BUILT_IN_SPEAKER,
        WIRED_HEADSET,
        BLUETOOTH_A2DP,
        BLUETOOTH_SCO,
        USB_DEVICE,
        HDMI,
        UNKNOWN
    }

    private var context: Context? = null
    private var audioManager: AudioManager? = null
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var a2dpProxy: BluetoothA2dp? = null
    private var activeDeviceCallback: ((AudioDevice) -> Unit)? = null
    private var deviceListCallback: ((List<AudioDevice>) -> Unit)? = null

    private val a2dpServiceListener = object : BluetoothProfile.ServiceListener {
        @Suppress("DEPRECATION")
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile == BluetoothProfile.A2DP) {
                a2dpProxy = proxy as? BluetoothA2dp
                Log.d(TAG, "A2DP proxy connected")
            }
        }

        @Suppress("DEPRECATION")
        override fun onServiceDisconnected(profile: Int) {
            if (profile == BluetoothProfile.A2DP) {
                a2dpProxy = null
                Log.d(TAG, "A2DP proxy disconnected")
            }
        }
    }

    private val a2dpReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                BluetoothDevice.ACTION_ACL_CONNECTED,
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                    Log.d(TAG, "Bluetooth connection changed: ${intent.action}")
                    notifyActiveDevice()
                    notifyDeviceList()
                }
                AudioManager.ACTION_AUDIO_BECOMING_NOISY -> {
                    Log.d(TAG, "Audio becoming noisy - device disconnected")
                }
            }
        }
    }

    fun initialize(ctx: Context) {
        context = ctx
        audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()

        bluetoothAdapter?.getProfileProxy(ctx, a2dpServiceListener, BluetoothProfile.A2DP)

        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
            addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        }
        ctx.registerReceiver(a2dpReceiver, filter)
    }

    fun release() {
        context?.let { ctx ->
            try {
                bluetoothAdapter?.closeProfileProxy(BluetoothProfile.A2DP, a2dpProxy)
            } catch (_: Exception) {}
            try {
                ctx.unregisterReceiver(a2dpReceiver)
            } catch (_: Exception) {}
        }
        a2dpProxy = null
        context = null
        audioManager = null
    }

    fun hasBluetoothConnectPermission(ctx: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) ==
                    PackageManager.PERMISSION_GRANTED
        } else true
    }

    fun getActiveDevice(): AudioDevice {
        val am = audioManager ?: return AudioDevice("Speaker", type = DeviceType.BUILT_IN_SPEAKER, isActive = true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            for (device in devices) {
                if (device.isSink) {
                    val type = when (device.type) {
                        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> DeviceType.BLUETOOTH_A2DP
                        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> DeviceType.BLUETOOTH_SCO
                        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> DeviceType.WIRED_HEADSET
                        AudioDeviceInfo.TYPE_WIRED_HEADSET -> DeviceType.WIRED_HEADSET
                        AudioDeviceInfo.TYPE_USB_DEVICE -> DeviceType.USB_DEVICE
                        AudioDeviceInfo.TYPE_USB_HEADSET -> DeviceType.USB_DEVICE
                        AudioDeviceInfo.TYPE_HDMI -> DeviceType.HDMI
                        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> DeviceType.BUILT_IN_SPEAKER
                        else -> null
                    }
                    if (type != null) {
                        return AudioDevice(
                            name = device.productName?.toString() ?: type.name,
                            address = device.address ?: "",
                            type = type,
                            isActive = true
                        )
                    }
                }
            }
        }

        val a2dp = a2dpProxy
        if (a2dp != null) {
            val ctx = context ?: return AudioDevice("Speaker", type = DeviceType.BUILT_IN_SPEAKER, isActive = true)
            if (hasBluetoothConnectPermission(ctx)) {
                try {
                    val connected = a2dp.connectedDevices
                    if (connected.isNotEmpty()) {
                        val first = connected[0]
                        return AudioDevice(
                            name = first.name ?: "Bluetooth",
                            address = first.address,
                            type = DeviceType.BLUETOOTH_A2DP,
                            isActive = true
                        )
                    }
                } catch (_: SecurityException) {}
            }
        }

        return AudioDevice("Speaker", type = DeviceType.BUILT_IN_SPEAKER, isActive = true)
    }

    fun getPairedBluetoothDevices(): List<AudioDevice> {
        val ctx = context ?: return emptyList()
        if (!hasBluetoothConnectPermission(ctx)) return emptyList()

        val adapter = bluetoothAdapter ?: return emptyList()
        val active = getActiveDevice()
        return try {
            adapter.bondedDevices.map { device ->
                AudioDevice(
                    name = device.name ?: "Unknown",
                    address = device.address,
                    type = DeviceType.BLUETOOTH_A2DP,
                    isActive = active.address == device.address
                )
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Bluetooth permission error", e)
            emptyList()
        }
    }

    fun isBluetoothConnected(): Boolean {
        val active = getActiveDevice()
        return active.type == DeviceType.BLUETOOTH_A2DP || active.type == DeviceType.BLUETOOTH_SCO
    }

    fun onActiveDeviceChanged(callback: (AudioDevice) -> Unit) {
        activeDeviceCallback = callback
    }

    fun onDeviceListChanged(callback: (List<AudioDevice>) -> Unit) {
        deviceListCallback = callback
    }

    /**
     * Use reflection to call hidden BluetoothA2dp methods (connect/disconnect).
     */
    private fun callA2dpMethod(device: BluetoothDevice, method: String): Boolean {
        val proxy = a2dpProxy ?: return false
        return try {
            val m = proxy.javaClass.getMethod(method, BluetoothDevice::class.java)
            m.invoke(proxy, device) as? Boolean ?: false
        } catch (e: Exception) {
            Log.w(TAG, "Reflection call $method failed: ${e.message}")
            false
        }
    }

    /**
     * Disconnect all connected Bluetooth A2DP devices, forcing audio back to speaker.
     */
    fun switchToSpeaker(): Boolean {
        val ctx = context ?: return false
        if (!hasBluetoothConnectPermission(ctx)) return false

        val a2dp = a2dpProxy
        if (a2dp == null) return false

        var disconnected = false
        try {
            val connected = a2dp.connectedDevices
            for (device in connected) {
                if (callA2dpMethod(device, "disconnect")) {
                    disconnected = true
                    Log.d(TAG, "Disconnected from ${device.name}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to disconnect Bluetooth", e)
        }
        notifyActiveDevice()
        return disconnected
    }

    /**
     * Connect to a specific Bluetooth device via A2DP.
     */
    fun connectToBluetooth(address: String): Boolean {
        val ctx = context ?: return false
        if (!hasBluetoothConnectPermission(ctx)) return false

        val adapter = bluetoothAdapter ?: return false
        try {
            val device = adapter.getRemoteDevice(address)
            if (device == null) {
                Log.w(TAG, "Device not found for address: $address")
                return false
            }
            val success = callA2dpMethod(device, "connect")
            if (success) {
                Log.d(TAG, "Connecting to ${device.name}")
            } else {
                Log.w(TAG, "Failed to initiate connection to ${device.name}")
            }
            notifyActiveDevice()
            return success
        } catch (e: SecurityException) {
            Log.w(TAG, "Bluetooth connect security error", e)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to connect Bluetooth", e)
        }
        return false
    }

    fun openOutputSwitcher(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val intent = Intent("com.android.settings.panel.action.MEDIA_OUTPUT").apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                ctx.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "Output switcher not available", e)
                openBluetoothSettings(ctx)
            }
        } else {
            openBluetoothSettings(ctx)
        }
    }

    fun openBluetoothSettings(ctx: Context) {
        try {
            val intent = Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            ctx.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Could not open Bluetooth settings", e)
        }
    }

    private fun notifyActiveDevice() {
        val device = getActiveDevice()
        activeDeviceCallback?.invoke(device)
    }

    private fun notifyDeviceList() {
        val devices = getPairedBluetoothDevices()
        deviceListCallback?.invoke(devices)
    }
}

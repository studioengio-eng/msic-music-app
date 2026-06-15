package com.msic.player

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject
import org.json.JSONArray
import android.content.Intent
import android.util.Log
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

import kotlinx.coroutines.*
import java.util.Locale

@InvokeArg
class PlayAudioArgs {
    var url: String = ""
    var title: String = "Desconocido"
    var artist: String = "Desconocido"
    var thumbnail: String = ""
    var duration: Long = 0
}

@InvokeArg
class SeekPlaybackArgs {
    var positionMs: Long = 0
}

@InvokeArg
class RadioQueueJsonArgs {
    var itemsJson: String = "[]"
}

@InvokeArg
class GetAudioArgs {
    var query: String = ""
    var youtubeUrl: String = ""
}

@InvokeArg
class SearchYouTubeArgs {
    var query: String = ""
    var limit: Int = 50
    var page: Int = 1
    /** NewPipe search filter token; empty = songs */
    var filter: String = ""
}

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val pluginScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    companion object {
        private const val PERMISSION_REQUEST_BLUETOOTH_CONNECT = 1001
        private var pendingPermissionInvoke: Invoke? = null

        @Volatile
        private var instance: PlayerPlugin? = null

        fun getInstance(): PlayerPlugin? = instance

        fun onPermissionResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
            if (requestCode == PERMISSION_REQUEST_BLUETOOTH_CONNECT) {
                val invoke = pendingPermissionInvoke
                pendingPermissionInvoke = null
                if (invoke != null) {
                    val result = JSObject()
                    result.put("granted", grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
                    invoke.resolve(result)
                }
            }
        }

        private fun parseQueueItems(items: JSONArray): List<TrackInfo> {
            val out = ArrayList<TrackInfo>()
            for (i in 0 until items.length()) {
                val item = items.optJSONObject(i) ?: continue
                val title = item.optString("title", "Desconocido")
                val artist = item.optString("artist", "Desconocido")
                val url = item.optString("url", "")
                val thumbnail = item.optString("thumbnail", "")
                val duration = item.optLong("duration", 0L)
                val isYoutubeUrl = url.contains("youtube.com") || url.contains("youtu.be")
                val isSoundCloudUrl = url.contains("soundcloud.com")
                val isDirectStream = url.startsWith("http") && !isYoutubeUrl && !isSoundCloudUrl
                out.add(TrackInfo(
                    title = title, artist = artist, coverUrl = thumbnail,
                    durationSeconds = duration,
                    youtubeUrl = if (isYoutubeUrl || isSoundCloudUrl) url else null,
                    streamUrl = if (isDirectStream) url else null
                ))
            }
            return out
        }
    }

    init {
        instance = this

        activity.runOnUiThread {
            val sessionToken = SessionToken(activity, ComponentName(activity, AudioPlayerService::class.java))
            controllerFuture = MediaController.Builder(activity, sessionToken).buildAsync()
            controllerFuture?.addListener({
                controller = controllerFuture?.get()
            }, MoreExecutors.directExecutor())
        }
    }

    override fun onDestroy() {
        pluginScope.cancel()
        instance = null
        super.onDestroy()
        controllerFuture?.let { MediaController.releaseFuture(it) }
    }

    @Command
    fun playAudio(invoke: Invoke) {
        val args = invoke.parseArgs(PlayAudioArgs::class.java)
        if (args.url.isEmpty() && args.title.isEmpty()) {
            invoke.reject("No track data provided")
            return
        }

        pluginScope.launch(Dispatchers.Main) {
            val isYoutubeUrl = args.url.contains("youtube.com") || args.url.contains("youtu.be")
            val isSoundCloudUrl = args.url.contains("soundcloud.com")
            val isDirectStream = args.url.startsWith("http") && !isYoutubeUrl && !isSoundCloudUrl
            val track = TrackInfo(
                title = args.title,
                artist = args.artist,
                coverUrl = args.thumbnail,
                durationSeconds = args.duration,
                youtubeUrl = if (isYoutubeUrl || isSoundCloudUrl) args.url else null,
                streamUrl = if (isDirectStream) args.url else null
            )

            QueueManager.setQueue(listOf(track), 0)
            PlayerManager.playTrack(track)

            controller?.let { PlayerManager.fadeIn() }
            invoke.resolve()
        }
    }

    @Command
    fun pausePlayback(invoke: Invoke) {
        activity.runOnUiThread {
            controller?.pause()
            PlayerManager.pause()
            invoke.resolve()
        }
    }

    @Command
    fun resumePlayback(invoke: Invoke) {
        activity.runOnUiThread {
            controller?.play()
            PlayerManager.resume()
            invoke.resolve()
        }
    }

    @Command
    fun stopPlayback(invoke: Invoke) {
        activity.runOnUiThread {
            QueueManager.clearQueue()
            controller?.stop()
            controller?.clearMediaItems()
            PlayerManager.stop()
            invoke.resolve()
        }
    }

    @Command
    fun seekPlayback(invoke: Invoke) {
        val args = invoke.parseArgs(SeekPlaybackArgs::class.java)
        activity.runOnUiThread {
            controller?.seekTo(args.positionMs.coerceAtLeast(0L))
            PlayerManager.seekTo(args.positionMs)
            invoke.resolve()
        }
    }

    @Command
    fun getPlaybackProgress(invoke: Invoke) {
        activity.runOnUiThread {
            val ctrl = controller
            if (ctrl == null) {
                invoke.reject("Controller not ready")
                return@runOnUiThread
            }
            val result = JSObject()
            result.put("position", if (ctrl.currentPosition >= 0) ctrl.currentPosition else 0L)
            result.put("duration", if (ctrl.duration > 0) ctrl.duration else 0L)
            result.put("isPlaying", ctrl.isPlaying)
            invoke.resolve(result)
        }
    }

    @Command
    fun getNowPlaying(invoke: Invoke) {
        val track = QueueManager.getCurrentTrack()
        val result = JSObject()
        result.put("title", track?.title ?: "")
        result.put("artist", track?.artist ?: "")
        result.put("coverUrl", track?.coverUrl ?: "")
        result.put("duration", track?.durationSeconds ?: 0)
        invoke.resolve(result)
    }

    @Command
    fun searchYouTube(invoke: Invoke) {
        val args = invoke.parseArgs(SearchYouTubeArgs::class.java)
        if (args.query.isEmpty()) {
            invoke.reject("Empty query")
            return
        }
        pluginScope.launch(Dispatchers.IO) {
            try {
                val ytFilter = args.filter.trim().ifEmpty { com.msic.api.NewPipeSearch.FILTER_SONGS }
                val results = com.msic.api.SearchManager.youtubeSearch(
                    args.query,
                    args.limit.coerceIn(1, 50),
                    args.page.coerceAtLeast(1),
                    ytFilter,
                )
                val jsonResults = org.json.JSONArray()
                for (r in results) {
                    val obj = JSObject()
                    obj.put("title", r.title)
                    obj.put("artist", r.artist)
                    obj.put("cover", r.cover)
                    obj.put("videoId", r.videoId)
                    obj.put("youtubeUrl", r.youtubeUrl)
                    obj.put("duration", r.duration)
                    obj.put("source", r.source)
                    obj.put("id", if (r.videoId.isNotBlank()) "yt:${r.videoId}" else "${r.source}:${r.title}:${r.artist}")
                    jsonResults.put(obj)
                }
                val result = JSObject()
                result.put("results", jsonResults)
                result.put("count", jsonResults.length())
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject("Search error: ${e.message}")
            }
        }
    }

    @Command
    fun getAudioUrl(invoke: Invoke) {
        val args = invoke.parseArgs(GetAudioArgs::class.java)
        if (args.query.isEmpty()) {
            invoke.reject("Empty query")
            return
        }
        pluginScope.launch(Dispatchers.IO) {
            try {
                val explicitUrl = if (args.youtubeUrl.isNotEmpty()) args.youtubeUrl
                    else if (args.query.startsWith("http")) args.query
                    else null
                val streamUrl = PlayerManager.resolveStreamUrl(args.query, explicitUrl)
                if (streamUrl != null) {
                    val result = JSObject()
                    result.put("url", streamUrl)
                    invoke.resolve(result)
                } else {
                    invoke.reject("Could not resolve stream URL")
                }
            } catch (e: Exception) {
                invoke.reject("Error: ${e.message}")
            }
        }
    }

    @Command
    fun setRadioQueue(invoke: Invoke) {
        val payload = invoke.parseArgs(RadioQueueJsonArgs::class.java)
        try {
            val items = JSONArray(payload.itemsJson)
            val tracks = parseQueueItems(items)
            QueueManager.replaceUpcoming(tracks)
            QueueManager.replaceUpcoming(tracks)
        } catch (e: Exception) {
            Log.e("PlayerPlugin", "Error setting queue: ${e.message}")
        }
        invoke.resolve()
    }

    @Command
    fun setRadioPrefetch(invoke: Invoke) {
        val args = invoke.parseArgs(PlayAudioArgs::class.java)
        if (args.url.isBlank() && args.title.isBlank()) {
            invoke.reject("No prefetch track data provided")
            return
        }

        val isYoutubeUrl = args.url.contains("youtube.com") || args.url.contains("youtu.be")
        val isSoundCloudUrl = args.url.contains("soundcloud.com")
        val isDirectStream = args.url.startsWith("http") && !isYoutubeUrl && !isSoundCloudUrl
        val track = TrackInfo(
            title = args.title,
            artist = args.artist,
            coverUrl = args.thumbnail,
            durationSeconds = args.duration,
            youtubeUrl = if (isYoutubeUrl || isSoundCloudUrl) args.url else null,
            streamUrl = if (isDirectStream) args.url else null
        )

        QueueManager.addToQueueIfNew(track)
        PlayerManager.preloadStream(track)
        invoke.resolve()
    }

    @Command
    fun clearRadioPrefetch(invoke: Invoke) {
        QueueManager.clearUpcoming()
        invoke.resolve()
    }

    @Command
    fun getRadioQueueSize(invoke: Invoke) {
        val result = JSObject()
        result.put("size", QueueManager.queueSize())
        invoke.resolve(result)
    }

    @Command
    fun importYouTubePlaylist(invoke: Invoke) {
        val args = invoke.parseArgs(GetAudioArgs::class.java)
        val playlistUrl = args.query.trim()
        if (playlistUrl.isEmpty()) {
            invoke.reject("Empty playlist URL")
            return
        }
        pluginScope.launch(Dispatchers.IO) {
            try {
                val videoId = extractVideoIdFromUrl(playlistUrl)
                if (videoId != null) {
                    val tracks = JSONArray()
                    val trackObj = JSObject()
                    trackObj.put("title", "YouTube Video")
                    trackObj.put("artist", "YouTube")
                    trackObj.put("url", playlistUrl)
                    trackObj.put("thumbnail", "https://i.ytimg.com/vi/$videoId/hqdefault.jpg")
                    trackObj.put("duration", 0)
                    tracks.put(trackObj)
                    val result = JSObject()
                    result.put("title", "YouTube Import")
                    result.put("tracks", tracks)
                    invoke.resolve(result)
                    return@launch
                }
                invoke.reject("Could not extract playlist info. Manual import supported for single videos only.")
            } catch (e: Exception) {
                invoke.reject("Playlist error: ${e.message}")
            }
        }
    }

    private fun extractVideoIdFromUrl(url: String): String? {
        return try {
            val uri = android.net.Uri.parse(url)
            var id = uri.getQueryParameter("v")
            if (id == null || id.length != 11) {
                val segments = uri.pathSegments
                if (segments != null && segments.size > 1) {
                    val last = segments.last()
                    if (last.length == 11) id = last
                }
            }
            id
        } catch (_: Exception) { null }
    }

    @Command
    fun getActiveAudioDevice(invoke: Invoke) {
        val device = AudioOutputManager.getActiveDevice()
        val result = JSObject()
        result.put("name", device.name)
        result.put("type", device.type.name)
        result.put("isActive", device.isActive)
        invoke.resolve(result)
    }

    @Command
    fun getPairedBluetoothDevices(invoke: Invoke) {
        val devices = AudioOutputManager.getPairedBluetoothDevices()
        val array = JSONArray()
        for (d in devices) {
            val obj = JSObject()
            obj.put("name", d.name)
            obj.put("address", d.address)
            obj.put("isActive", d.isActive)
            array.put(obj)
        }
        val result = JSObject()
        result.put("devices", array)
        invoke.resolve(result)
    }

    @Command
    fun switchToSpeaker(invoke: Invoke) {
        val ok = AudioOutputManager.switchToSpeaker()
        val result = JSObject()
        result.put("switched", ok)
        if (!ok) {
            AudioOutputManager.openOutputSwitcher(activity)
        }
        invoke.resolve(result)
    }

    @InvokeArg
    class BluetoothDeviceArgs { var address: String = "" }

    @Command
    fun connectToBluetoothDevice(invoke: Invoke) {
        val args = invoke.parseArgs(BluetoothDeviceArgs::class.java)
        val ok = AudioOutputManager.connectToBluetooth(args.address)
        val result = JSObject()
        result.put("connected", ok)
        if (!ok) {
            AudioOutputManager.openOutputSwitcher(activity)
        }
        invoke.resolve(result)
    }

    @Command
    fun openOutputSwitcher(invoke: Invoke) {
        AudioOutputManager.openOutputSwitcher(activity)
        invoke.resolve()
    }

    @Command
    fun openBluetoothSettings(invoke: Invoke) {
        AudioOutputManager.openBluetoothSettings(activity)
        invoke.resolve()
    }

    @Command
    fun requestBluetoothPermission(invoke: Invoke) {
        if (AudioOutputManager.hasBluetoothConnectPermission(activity)) {
            val result = JSObject()
            result.put("granted", true)
            invoke.resolve(result)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            pendingPermissionInvoke = invoke
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.BLUETOOTH_CONNECT),
                PERMISSION_REQUEST_BLUETOOTH_CONNECT
            )
        } else {
            val result = JSObject()
            result.put("granted", true)
            invoke.resolve(result)
        }
    }

    @InvokeArg
    class AutoplayArgs { var enabled: Boolean = true }

    @InvokeArg
    class RepeatModeArgs { var mode: String = "off" }

    @Command
    fun setAutoplayEnabled(invoke: Invoke) {
        val args = invoke.parseArgs(AutoplayArgs::class.java)
        // AutoPlayManager is deprecated, React handles autoplay
        // AutoPlayManager.setAutoplayEnabled(args.enabled)
        invoke.resolve()
    }

    @Command
    fun fillAutoplayQueue(invoke: Invoke) {
        // AutoPlayManager is deprecated
        // AutoPlayManager.fillQueueWithAutoplay(6)
        invoke.resolve()
    }

    @Command
    fun setRepeatMode(invoke: Invoke) {
        val args = invoke.parseArgs(RepeatModeArgs::class.java)
        // AutoPlayManager is deprecated
        // AutoPlayManager.setRepeatMode(args.mode)
        invoke.resolve()
    }
}

class MainActivity : TauriActivity() {
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        PlaybackBridge.register(webView)
        AudioOutputManager.initialize(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 1001)
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        PlayerPlugin.onPermissionResult(requestCode, permissions, grantResults)
    }

    override fun onPause() {
        super.onPause()
        PlaybackBridge.onActivityPause()
    }

    override fun onResume() {
        PlaybackBridge.onActivityResume()
        super.onResume()
    }

    override fun onDestroy() {
        AudioOutputManager.release()
        PlaybackBridge.clear()
        super.onDestroy()
    }
}

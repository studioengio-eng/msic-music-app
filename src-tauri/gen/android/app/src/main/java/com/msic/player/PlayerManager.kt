package com.msic.player

import android.content.Context
import android.util.Log
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.msic.api.NewPipePlayer
import com.msic.api.NewPipeSearch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

object PlayerManager {
    private const val TAG = "PlayerManager"
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    var player: ExoPlayer? = null
        private set

    private var playbackJob: Job? = null
    private var preloadJob: Job? = null
    private val playbackGeneration = AtomicLong(0)
    private val pendingStreams = LinkedHashMap<String, kotlinx.coroutines.Deferred<String?>>()

    @Suppress("UNUSED_PARAMETER")
    fun initialize(context: Context, newPlayer: ExoPlayer) {
        player = newPlayer

        newPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_ENDED -> {
                        PlaybackBridge.onPlaybackEnded()
                    }
                    Player.STATE_READY -> {
                        Log.d(TAG, "Player ready, duration: ${newPlayer.duration}")
                        // Delegamos preload a React
                    }
                }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                Log.e(TAG, "Player error: ${error.message} errorCode=${error.errorCode}")
                PlaybackBridge.onPlaybackEnded()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
            }
        })
    }

    suspend fun resolveStreamUrl(query: String, explicitUrl: String? = null): String? = withContext(Dispatchers.IO) {
        val key = "${query.trim().lowercase()}|${explicitUrl.orEmpty()}"
        pendingStreams[key]?.let { return@withContext it.await() }

        val deferred = scope.async(Dispatchers.IO) {
            var trackUrl: String? = null

            if (!explicitUrl.isNullOrEmpty()) {
                trackUrl = when {
                    // Already a full YouTube URL
                    explicitUrl.contains("youtube.com/watch") || explicitUrl.contains("youtu.be/") ->
                        explicitUrl
                    // Bare 11-char YouTube video ID
                    explicitUrl.matches(Regex("[A-Za-z0-9_-]{11}")) ->
                        "https://www.youtube.com/watch?v=$explicitUrl"
                    // Full URL (other)
                    explicitUrl.startsWith("http") ->
                        explicitUrl
                    else -> null
                }
            }

            if (trackUrl == null) {
                val results = com.msic.api.SearchManager.playableSearch(query, limit = 3)
                val first = results.firstOrNull()
                trackUrl = first?.youtubeUrl?.takeIf { it.isNotBlank() }
                    ?: first?.videoId?.takeIf { it.isNotBlank() }
                        ?.let { "https://www.youtube.com/watch?v=$it" }
            }

            if (trackUrl == null) null else NewPipePlayer.resolveStreamUrl(trackUrl)
        }

        pendingStreams[key] = deferred
        try {
            deferred.await()
        } finally {
            pendingStreams.remove(key)
        }
    }


    private fun extractVideoId(url: String): String? {
        return try {
            val uri = android.net.Uri.parse(url)
            uri.getQueryParameter("v") ?: uri.pathSegments?.lastOrNull()
        } catch (_: Exception) { null }
    }

    fun playTrack(track: TrackInfo) {
        val generation = playbackGeneration.incrementAndGet()
        playbackJob?.cancel()
        preloadJob?.cancel()

        playbackJob = scope.launch {
            val existingStream = track.streamUrl?.takeIf { it.isNotBlank() }
            val url = existingStream ?: async(Dispatchers.IO) {
                resolveStreamUrl("${track.artist} - ${track.title}", track.youtubeUrl)
            }.await()

            if (generation != playbackGeneration.get()) return@launch

            if (url != null) {
                track.streamUrl = url
                player?.let { p ->
                    p.setMediaItem(track.toMediaItem())
                    p.prepare()
                    p.play()
                }
            } else {
                Log.e(TAG, "Could not resolve stream for: ${track.title}")
                PlaybackBridge.onPlaybackEnded()
            }
        }
    }

    fun preloadStream(track: TrackInfo, callback: (Boolean) -> Unit = {}) {
        preloadJob?.cancel()
        val generation = playbackGeneration.get()

        preloadJob = scope.launch {
            delay(220L)
            if (generation != playbackGeneration.get()) {
                callback(false)
                return@launch
            }

            if (track.streamUrl != null) {
                callback(true)
                return@launch
            }

            val url = async(Dispatchers.IO) {
                resolveStreamUrl("${track.artist} - ${track.title}", track.youtubeUrl)
            }.await()

            if (generation != playbackGeneration.get()) {
                callback(false)
                return@launch
            }

            if (url != null) {
                track.streamUrl = url
                callback(true)
            } else {
                Log.w(TAG, "Preload failed for: ${track.title}")
                callback(false)
            }
        }
    }

    fun playNextInQueue() {
        preloadJob?.cancel()
        val next = QueueManager.nextTrack() ?: return
        if (next.streamUrl != null) {
            player?.let { p ->
                p.setMediaItem(next.toMediaItem())
                p.prepare()
                p.play()
            }
        } else {
            playTrack(next)
        }
    }

    fun getPlayerPosition(): Long {
        return player?.currentPosition ?: 0L
    }

    fun getPlayerDuration(): Long {
        return player?.duration ?: 0L
    }

    fun isPlaying(): Boolean {
        return player?.isPlaying ?: false
    }

    fun seekTo(positionMs: Long) {
        player?.seekTo(positionMs.coerceAtLeast(0L))
    }

    fun pause() {
        player?.pause()
    }

    fun resume() {
        player?.play()
    }

    fun stop() {
        playbackGeneration.incrementAndGet()
        playbackJob?.cancel()
        preloadJob?.cancel()
        player?.stop()
        player?.clearMediaItems()
    }

    fun getVolume(): Float = player?.volume ?: 1f

    fun setVolume(volume: Float) {
        player?.volume = volume.coerceIn(0f, 1f)
    }

    fun release() {
        playbackJob?.cancel()
        preloadJob?.cancel()
        player?.release()
        player = null
    }

    fun fadeIn(durationMs: Long = 600L) {
        val p = player ?: return
        p.volume = 0f
        val steps = 12
        val interval = durationMs / steps
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        var step = 0
        val runnable = object : Runnable {
            override fun run() {
                if (step <= steps) {
                    p.volume = step.toFloat() / steps.toFloat()
                    step++
                    handler.postDelayed(this, interval)
                }
            }
        }
        handler.post(runnable)
    }
}

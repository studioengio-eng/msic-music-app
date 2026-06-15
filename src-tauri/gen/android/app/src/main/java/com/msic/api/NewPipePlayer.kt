package com.msic.api

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.AudioStream
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object NewPipePlayer {
    private const val TAG = "NewPipePlayer"

    @Volatile
    private var initialized = false

    private fun ensureInitialized() {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .build()
                NewPipe.init(NewPipeDownloader(client))
                initialized = true
                Log.d(TAG, "NewPipeExtractor initialized successfully")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to initialize NewPipeExtractor: ${e.message}", e)
            }
        }
    }

    suspend fun resolveStreamUrl(trackUrl: String): String? = withContext(Dispatchers.IO) {
        if (trackUrl.isBlank()) return@withContext null
        val cacheKey = "stream:$trackUrl"
        CacheManager.getStream(cacheKey)?.let {
            Log.d(TAG, "Cache hit for $trackUrl")
            return@withContext it
        }

        ensureInitialized()

        var url: String? = null
        try {
            val streamInfo = StreamInfo.getInfo(ServiceList.YouTube, trackUrl)

            // Get available audio streams
            val audioStreams = streamInfo.audioStreams ?: emptyList<AudioStream>()
            Log.d(TAG, "Available audio streams: ${audioStreams.size} for $trackUrl")

            if (audioStreams.isNotEmpty()) {
                // Prefer WEBM/OPUS > M4A/AAC, highest bitrate
                val sortedStreams = audioStreams.sortedWith(
                    compareByDescending<AudioStream> {
                        val fmt = listOfNotNull(
                            it.format?.name,
                            it.format?.suffix,
                            it.format?.mimeType,
                            it.codec,
                        ).joinToString(" ").uppercase()
                        when {
                            fmt.contains("WEBM") || fmt.contains("OPUS") -> 3
                            fmt.contains("M4A")  || fmt.contains("AAC")  -> 2
                            else -> 1
                        }
                    }.thenByDescending { it.averageBitrate }
                )

                val bestStream = sortedStreams.firstOrNull()
                url = bestStream?.content  // NewPipe uses .content for the URL
                if (url.isNullOrBlank()) {
                    @Suppress("DEPRECATION")
                    url = bestStream?.url
                }
                Log.d(TAG, "Best stream: format=${bestStream?.format?.name} bitrate=${bestStream?.averageBitrate} url=${url?.take(80)}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to resolve stream for YouTube url=$trackUrl: ${e.message}", e)
        }

        if (url != null) {
            CacheManager.putStream(cacheKey, url, ttlMs = CacheManager.STREAM_TTL_MS)
            Log.d(TAG, "Resolved stream for $trackUrl: ${url.take(80)}...")
        } else {
            Log.w(TAG, "Could not resolve stream for $trackUrl")
        }

        return@withContext url
    }

    suspend fun resolveSearchQueryToStreamUrl(query: String): String? {
        val results = NewPipeSearch.search(query, limit = 3, filter = NewPipeSearch.FILTER_SONGS)
        val first = results.firstOrNull { it.videoId.isNotEmpty() } ?: return null
        val ytUrl = first.youtubeUrl.ifBlank { "https://www.youtube.com/watch?v=${first.videoId}" }
        return resolveStreamUrl(ytUrl)
    }
}

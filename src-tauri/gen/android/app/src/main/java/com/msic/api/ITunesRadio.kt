package com.msic.api

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

object ITunesRadio {
    private const val TAG = "ITunesRadio"
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    data class RadioTrack(
        val title: String,
        val artist: String,
        val durationSeconds: Long,
        val coverUrl: String?
    )

    suspend fun getRadioTracks(artistName: String): List<RadioTrack> = withContext(Dispatchers.IO) {
        try {
            var cleanArtistName = artistName
                .replace(Regex(" - Topic$", RegexOption.IGNORE_CASE), "")
                .replace(Regex(" VEVO$", RegexOption.IGNORE_CASE), "")
                .replace(Regex("\\(feat\\..*?\\)", RegexOption.IGNORE_CASE), "")
                .replace(Regex("feat\\..*", RegexOption.IGNORE_CASE), "")
                .trim()
                
            if (cleanArtistName.isBlank()) cleanArtistName = artistName

            val query = URLEncoder.encode(cleanArtistName, "UTF-8")
            val url = "https://itunes.apple.com/search?term=$query&entity=song&limit=50"

            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()
            if (!response.isSuccessful) return@withContext emptyList()

            val json = JSONObject(response.body?.string() ?: return@withContext emptyList())
            val results = json.optJSONArray("results") ?: return@withContext emptyList()

            val tracks = mutableListOf<RadioTrack>()
            for (i in 0 until results.length()) {
                val trackObj = results.getJSONObject(i)
                val title = trackObj.optString("trackName")
                val artist = trackObj.optString("artistName")
                val durationMs = trackObj.optLong("trackTimeMillis", 0L)
                val artwork = trackObj.optString("artworkUrl100").replace("100x100bb.jpg", "500x500bb.jpg")

                if (title.isNotBlank()) {
                    tracks.add(
                        RadioTrack(
                            title = title,
                            artist = artist,
                            durationSeconds = durationMs / 1000,
                            coverUrl = artwork
                        )
                    )
                }
            }

            return@withContext tracks.shuffled()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get iTunes radio for $artistName", e)
            return@withContext emptyList()
        }
    }
}

package com.msic.player

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object RecommendationEngine {
    data class CandidateTrack(
        val title: String,
        val artist: String,
        val durationSeconds: Long,
        val youtubeUrl: String? = null,
        val coverUrl: String? = null,
        var score: Int = 0
    )

    private fun key(title: String, artist: String): String {
        return "${title.cleanTitle()}::${artist.cleanArtist()}"
    }

    private fun String.cleanTitle(): String =
        lowercase()
            .replace(Regex("\\(.*?\\)"), " ")
            .replace(Regex("\\[.*?\\]"), " ")
            .replace(Regex("-.*"), " ")
            .replace(Regex("ft\\..*"), " ")
            .replace(Regex("feat\\..*"), " ")
            .trim()

    private fun String.cleanArtist(): String =
        lowercase()
            .replace(Regex("-.*"), " ")
            .replace(Regex(",.*"), " ")
            .replace(Regex("&.*"), " ")
            .trim()

    suspend fun getRecommendations(
        seedTitle: String,
        seedArtist: String,
        sessionTracks: List<Pair<String, String>>
    ): List<CandidateTrack> = withContext(Dispatchers.IO) {
        val known = sessionTracks.map { key(it.first, it.second) }.toMutableSet()
        val knownTitles = sessionTracks.map { it.first.cleanTitle() }.toMutableSet()
        
        known.add(key(seedTitle, seedArtist))
        knownTitles.add(seedTitle.cleanTitle())

        var itunesRadio = com.msic.api.ITunesRadio.getRadioTracks(seedArtist)
        val radioCandidates = mutableListOf<CandidateTrack>()
        
        fun processTracks(tracks: List<com.msic.api.ITunesRadio.RadioTrack>) {
            for (track in tracks) {
                val title = track.title.cleanTitle()
                val artist = track.artist.cleanArtist()
                
                if (title.isBlank() || artist.isBlank()) continue
                if (known.contains(key(title, artist))) continue
                if (knownTitles.contains(title)) continue
                
                radioCandidates.add(
                    CandidateTrack(
                        title = track.title,
                        artist = track.artist,
                        durationSeconds = track.durationSeconds,
                        youtubeUrl = null,
                        coverUrl = track.coverUrl,
                        score = 100 - radioCandidates.size
                    )
                )
                known.add(key(title, artist))
                knownTitles.add(title)
            }
        }

        processTracks(itunesRadio)

        // PIVOT: If iTunes runs out of tracks for this artist, grab recent artists from the session
        if (radioCandidates.isEmpty() && sessionTracks.isNotEmpty()) {
            val recentArtists = sessionTracks.map { it.second }.distinct().reversed().take(5)
            for (fallbackArtist in recentArtists) {
                if (fallbackArtist.cleanArtist() == seedArtist.cleanArtist()) continue
                
                val fallbackRadio = com.msic.api.ITunesRadio.getRadioTracks(fallbackArtist)
                processTracks(fallbackRadio)
                if (radioCandidates.size >= 5) break // found enough to continue
            }
        }

        return@withContext radioCandidates.take(25)
    }
}

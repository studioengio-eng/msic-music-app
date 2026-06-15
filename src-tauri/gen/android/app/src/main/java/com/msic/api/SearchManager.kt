package com.msic.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class SearchResult(
    val title: String,
    val artist: String,
    val cover: String,
    val videoId: String = "",
    val youtubeUrl: String = "",
    val duration: Long = 0,
    val source: String = "youtube"
)

object SearchManager {
    suspend fun youtubeSearch(
        query: String,
        limit: Int = 50,
        page: Int = 1,
        filter: String = NewPipeSearch.KIND_SONGS,
    ): List<SearchResult> = withContext(Dispatchers.IO) {
        val q = query.trim()
        if (q.isEmpty()) return@withContext emptyList()

        val kind = normalizeFilter(filter)
        val results = NewPipeSearch.search(q, limit, page, kind)
        if (results.isNotEmpty()) return@withContext results

        when (kind) {
            NewPipeSearch.KIND_SONGS -> NewPipeSearch.search(q, limit, page, NewPipeSearch.KIND_VIDEOS)
                .filter { it.source == "youtube" }
                .ifEmpty {
                    NewPipeSearch.search(q, limit, page, NewPipeSearch.KIND_ALL)
                        .filter { it.source == "youtube" && (it.videoId.isNotBlank() || it.youtubeUrl.isNotBlank()) }
                }
            NewPipeSearch.KIND_VIDEOS -> NewPipeSearch.search(q, limit, page, NewPipeSearch.KIND_ALL)
                .filter { it.source == "youtube" && (it.videoId.isNotBlank() || it.youtubeUrl.isNotBlank()) }
            NewPipeSearch.KIND_ARTISTS -> NewPipeSearch.search(q, limit, page, NewPipeSearch.KIND_ALL)
                .filter { it.source == "artist" }
            NewPipeSearch.KIND_ALBUMS -> NewPipeSearch.search(q, limit, page, NewPipeSearch.KIND_ALL)
                .filter { it.source == "album" }
            else -> emptyList()
        }
    }

    suspend fun playableSearch(query: String, limit: Int = 20): List<SearchResult> {
        return youtubeSearch(query, limit, 1, NewPipeSearch.KIND_SONGS)
            .filter { it.source == "youtube" && (it.videoId.isNotBlank() || it.youtubeUrl.isNotBlank()) }
    }

    suspend fun parallelSearch(query: String, limit: Int = 20): NewPipeSearch.ParallelResults {
        return NewPipeSearch.parallelSearch(query, limit)
    }

    private fun normalizeFilter(filter: String): String {
        return when (filter.trim().lowercase()) {
            NewPipeSearch.KIND_VIDEOS -> NewPipeSearch.KIND_VIDEOS
            NewPipeSearch.KIND_ARTISTS -> NewPipeSearch.KIND_ARTISTS
            NewPipeSearch.KIND_ALBUMS -> NewPipeSearch.KIND_ALBUMS
            NewPipeSearch.KIND_ALL -> NewPipeSearch.KIND_ALL
            else -> NewPipeSearch.KIND_SONGS
        }
    }
}

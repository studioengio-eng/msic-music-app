package com.msic.api

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.channel.ChannelInfoItem
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.util.concurrent.TimeUnit

object NewPipeSearch {
    private const val TAG = "NewPipeSearch"

    const val KIND_SONGS = "songs"
    const val KIND_VIDEOS = "videos"
    const val KIND_ARTISTS = "artists"
    const val KIND_ALBUMS = "albums"
    const val KIND_ALL = "all"

    const val FILTER_SONGS = KIND_SONGS
    const val FILTER_VIDEOS = KIND_VIDEOS
    const val FILTER_ALBUMS = KIND_ALBUMS
    const val FILTER_ARTISTS = KIND_ARTISTS

    private const val YTM_SONGS = "EgWKAQIIAWoKEAoQCRADEAA%3D%3D"
    private const val YTM_VIDEOS = "EgWKAQIQAWoKEAoQCRADEAA%3D%3D"
    private const val YTM_ARTISTS = "EgWKAQIgAWoKEAoQCRADEAA%3D%3D"
    private const val YTM_ALBUMS = "EgWKAQIYAWoKEAoQCRADEAA%3D%3D"

    @Volatile
    private var initialized = false
    private val pageCache = LinkedHashMap<String, Page>()

    private fun ensureInitialized() {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            val client = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build()
            NewPipe.init(NewPipeDownloader(client))
            initialized = true
            Log.d(TAG, "NewPipe initialized")
        }
    }

    suspend fun search(
        query: String,
        limit: Int = 50,
        page: Int = 1,
        filter: String? = KIND_SONGS
    ): List<SearchResult> = withContext(Dispatchers.IO) {
        val q = query.trim()
        if (q.isEmpty()) return@withContext emptyList()

        val kind = normalizeKind(filter)
        val cacheKey = "np:$q:$kind:$page"
        CacheManager.getSearch(cacheKey)?.let { return@withContext it.take(limit) }

        ensureInitialized()

        val token = filterToken(kind)
        val pageKey = "$q:$kind"
        val extractor = ServiceList.YouTube.getSearchExtractor(
            q,
            token?.let { listOf(it) } ?: emptyList(),
            null
        )

        val items = try {
            if (page > 1 && pageCache[pageKey] != null) {
                val result = extractor.getPage(pageCache[pageKey])
                rememberPage(pageKey, result.nextPage)
                result.items
            } else {
                extractor.fetchPage()
                val result = extractor.initialPage
                rememberPage(pageKey, result.nextPage)
                result.items
            }
        } catch (e: Exception) {
            Log.w(TAG, "Search failed q=$q kind=$kind: ${e.message}")
            return@withContext emptyList()
        }

        val results = items.mapNotNull { item ->
            when (item) {
                is StreamInfoItem -> streamToResult(item, kind)
                is ChannelInfoItem -> channelToResult(item, kind)
                is PlaylistInfoItem -> playlistToResult(item, kind)
                else -> null
            }
        }.let { dedupe(it) }.take(limit)

        if (page <= 1 && results.isNotEmpty()) CacheManager.putSearch(cacheKey, results)
        return@withContext results
    }

    private fun streamToResult(item: StreamInfoItem, kind: String): SearchResult? {
        if (kind == KIND_ARTISTS || kind == KIND_ALBUMS) return null
        val url = item.url ?: return null
        val videoId = extractVideoId(url) ?: return null
        val title = item.name?.trim().orEmpty()
        if (title.isEmpty()) return null

        return SearchResult(
            title = title,
            artist = item.uploaderName?.trim().orEmpty().ifEmpty { "Desconocido" },
            cover = item.thumbnails.firstOrNull()?.url ?: "https://i.ytimg.com/vi/$videoId/hqdefault.jpg",
            videoId = videoId,
            youtubeUrl = url,
            duration = item.duration,
            source = "youtube"
        )
    }

    private fun channelToResult(item: ChannelInfoItem, kind: String): SearchResult? {
        if (kind != KIND_ARTISTS && kind != KIND_ALL) return null
        val title = item.name?.trim().orEmpty()
        if (title.isEmpty()) return null
        return SearchResult(
            title = title,
            artist = "Artista",
            cover = item.thumbnails.firstOrNull()?.url.orEmpty(),
            videoId = "",
            youtubeUrl = item.url.orEmpty(),
            duration = 0,
            source = "artist"
        )
    }

    private fun playlistToResult(item: PlaylistInfoItem, kind: String): SearchResult? {
        if (kind != KIND_ALBUMS && kind != KIND_ALL) return null
        val title = item.name?.trim().orEmpty()
        if (title.isEmpty()) return null
        return SearchResult(
            title = title,
            artist = item.uploaderName?.trim().orEmpty().ifEmpty { "Album" },
            cover = item.thumbnails.firstOrNull()?.url.orEmpty(),
            videoId = "",
            youtubeUrl = item.url.orEmpty(),
            duration = 0,
            source = "album"
        )
    }

    private fun normalizeKind(filter: String?): String {
        return when (filter?.trim()?.lowercase()) {
            KIND_VIDEOS, YTM_VIDEOS -> KIND_VIDEOS
            KIND_ARTISTS, YTM_ARTISTS -> KIND_ARTISTS
            KIND_ALBUMS, YTM_ALBUMS -> KIND_ALBUMS
            KIND_ALL, "", null -> KIND_ALL
            else -> KIND_SONGS
        }
    }

    private fun filterToken(kind: String): String? {
        return when (kind) {
            KIND_SONGS -> YTM_SONGS
            KIND_VIDEOS -> YTM_VIDEOS
            KIND_ARTISTS -> YTM_ARTISTS
            KIND_ALBUMS -> YTM_ALBUMS
            else -> null
        }
    }

    private fun rememberPage(key: String, next: Page?) {
        if (next == null) pageCache.remove(key) else pageCache[key] = next
        while (pageCache.size > 40) {
            val first = pageCache.keys.firstOrNull() ?: break
            pageCache.remove(first)
        }
    }

    private fun dedupe(results: List<SearchResult>): List<SearchResult> {
        val seen = HashSet<String>()
        return results.filter {
            val key = "${it.source}|${it.title.normalize()}|${it.artist.normalize()}|${it.videoId}|${it.youtubeUrl}"
            seen.add(key)
        }
    }

    private fun String.normalize(): String =
        lowercase().replace(Regex("\\s+"), " ").trim()

    private fun extractVideoId(url: String): String? {
        return try {
            val uri = android.net.Uri.parse(url)
            uri.getQueryParameter("v")
                ?: if (url.contains("youtu.be/")) url.substringAfterLast("youtu.be/").substringBefore("?")
                else uri.pathSegments?.lastOrNull()?.takeIf { it.length == 11 }
        } catch (_: Exception) {
            null
        }
    }

    suspend fun parallelSearch(query: String, limit: Int = 20): ParallelResults = coroutineScope {
        val songs = async { search(query, limit, 1, KIND_SONGS) }
        val artists = async { search(query, 8, 1, KIND_ARTISTS) }
        val albums = async { search(query, 8, 1, KIND_ALBUMS) }
        val mixed = async { search(query, limit, 1, KIND_ALL) }
        ParallelResults(songs.await(), artists.await(), albums.await(), mixed.await())
    }

    data class ParallelResults(
        val songs: List<SearchResult>,
        val artists: List<SearchResult>,
        val albums: List<SearchResult>,
        val mixed: List<SearchResult>
    )
}

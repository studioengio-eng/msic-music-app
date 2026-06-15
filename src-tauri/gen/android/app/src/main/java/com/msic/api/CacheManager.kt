package com.msic.api

import android.util.LruCache

object CacheManager {
    private const val SEARCH_TTL_MS  = 3  * 60 * 1000L
    const val STREAM_TTL_MS          = 8  * 60 * 1000L
    private const val BROWSE_TTL_MS  = 5  * 60 * 1000L  // bumped from 3 min
    private const val METADATA_TTL_MS = 5 * 60 * 1000L

    private data class CacheEntry<T>(
        val data: T,
        val expiresAt: Long
    ) {
        fun isValid() = System.currentTimeMillis() < expiresAt
    }

    private val searchCache   = LruCache<String, CacheEntry<List<SearchResult>>>(50)
    private val streamCache   = LruCache<String, CacheEntry<String>>(200)
    private val browseCache   = LruCache<String, CacheEntry<List<CandidateTrack>>>(50)
    private val metadataCache = LruCache<String, CacheEntry<String>>(200)

    data class CandidateTrack(
        val title: String,
        val artist: String,
        val durationSeconds: Long = 0,
        val youtubeUrl: String? = null,
        val coverUrl: String? = null,
        val videoId: String? = null
    )

    // ── Search ────────────────────────────────────────────────────────────────

    fun getSearch(key: String): List<SearchResult>? {
        val entry = searchCache.get(key) ?: return null
        if (!entry.isValid()) { searchCache.remove(key); return null }
        return entry.data
    }

    fun putSearch(key: String, results: List<SearchResult>) {
        searchCache.put(key, CacheEntry(results, System.currentTimeMillis() + SEARCH_TTL_MS))
    }

    // ── Stream URLs ───────────────────────────────────────────────────────────

    fun getStream(key: String): String? {
        val entry = streamCache.get(key) ?: return null
        if (!entry.isValid()) { streamCache.remove(key); return null }
        return entry.data
    }

    fun putStream(key: String, url: String, ttlMs: Long = STREAM_TTL_MS) {
        streamCache.put(key, CacheEntry(url, System.currentTimeMillis() + ttlMs))
    }

    fun invalidateStream(key: String) {
        streamCache.remove(key)
    }

    // ── Browse / Radio ────────────────────────────────────────────────────────

    fun getBrowse(key: String): List<CandidateTrack>? {
        val entry = browseCache.get(key) ?: return null
        if (!entry.isValid()) { browseCache.remove(key); return null }
        return entry.data
    }

    fun putBrowse(key: String, tracks: List<CandidateTrack>) {
        browseCache.put(key, CacheEntry(tracks, System.currentTimeMillis() + BROWSE_TTL_MS))
    }

    // ── Metadata ──────────────────────────────────────────────────────────────

    fun getMetadata(key: String): String? {
        val entry = metadataCache.get(key) ?: return null
        if (!entry.isValid()) { metadataCache.remove(key); return null }
        return entry.data
    }

    fun putMetadata(key: String, json: String) {
        metadataCache.put(key, CacheEntry(json, System.currentTimeMillis() + METADATA_TTL_MS))
    }

    // ── Housekeeping ──────────────────────────────────────────────────────────

    fun invalidateAll() {
        searchCache.evictAll()
        streamCache.evictAll()
        browseCache.evictAll()
        metadataCache.evictAll()
    }
}

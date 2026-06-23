package com.msic.player

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata

data class TrackInfo(
    val title: String,
    val artist: String,
    val coverUrl: String = "",
    val durationSeconds: Long = 0,
    var youtubeUrl: String? = null,
    var streamUrl: String? = null,
    val genres: List<String> = emptyList(),
    val id: String = "$artist - $title"
) {
    fun toMediaItem(): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setArtworkUri(if (coverUrl.isNotEmpty()) Uri.parse(coverUrl) else null)
            .build()

        return MediaItem.Builder()
            .setMediaId(id)
            .setUri(if (!streamUrl.isNullOrEmpty()) Uri.parse(streamUrl) else Uri.EMPTY)
            .setMediaMetadata(metadata)
            .build()
    }

    fun key(): Pair<String, String> = Pair(title.lowercase(), artist.lowercase())
}

object QueueManager {
    private val queue = mutableListOf<TrackInfo>()
    private val history = ArrayDeque<Pair<String, String>>()
    private val sessionPlayed = mutableSetOf<String>()
    private var currentIndex = -1
    private var isShuffled = false
    private val shuffleOrder = mutableListOf<Int>()
    private var repeatMode = "off"

    private const val MAX_HISTORY_SIZE = 100
    private const val MAX_AUTOPLAY_BUFFER = 4

    @Synchronized
    fun getQueue(): List<TrackInfo> = queue.toList()

    @Synchronized
    fun getCurrentIndex(): Int = currentIndex

    @Synchronized
    fun getCurrentTrack(): TrackInfo? {
        return if (currentIndex in queue.indices) queue[currentIndex] else null
    }

    @Synchronized
    fun addToQueue(track: TrackInfo) {
        queue.add(track)
        if (isShuffled && currentIndex >= 0) {
            shuffleOrder.add(queue.size - 1)
        }
    }

    @Synchronized
    fun addToQueueIfNew(track: TrackInfo): Boolean {
        val key = track.key()
        val exists = queue.any { it.key() == key || it.id == track.id } || history.any { it == key }
        if (exists) return false
        addToQueue(track)
        return true
    }

    @Synchronized
    fun addToQueueNext(track: TrackInfo) {
        if (currentIndex == -1) {
            queue.add(track)
            if (isShuffled) shuffleOrder.add(0)
        } else {
            queue.add(currentIndex + 1, track)
            if (isShuffled) {
                for (i in shuffleOrder.indices) {
                    if (shuffleOrder[i] > currentIndex) {
                        shuffleOrder[i] = shuffleOrder[i] + 1
                    }
                }
                shuffleOrder.add(currentIndex + 1)
            }
        }
    }

    @Synchronized
    fun setQueue(tracks: List<TrackInfo>, startIndex: Int = 0) {
        queue.clear()
        queue.addAll(tracks)
        currentIndex = if (startIndex in queue.indices) startIndex else 0
        isShuffled = false
        shuffleOrder.clear()
    }

    @Synchronized
    fun replaceUpcoming(tracks: List<TrackInfo>) {
        val keepUntil = currentIndex.coerceAtLeast(-1) + 1
        while (queue.size > keepUntil) {
            queue.removeAt(queue.lastIndex)
        }

        val seen = queue.map { it.key() }.toMutableSet()
        seen.addAll(history)
        for (track in tracks) {
            val key = track.key()
            if (seen.add(key)) {
                queue.add(track)
            }
        }
    }

    @Synchronized
    fun replaceUpcomingNoDeduplicate(tracks: List<TrackInfo>) {
        val keepUntil = currentIndex.coerceAtLeast(-1) + 1
        while (queue.size > keepUntil) {
            queue.removeAt(queue.lastIndex)
        }
        queue.addAll(tracks)
    }

    @Synchronized
    fun nextTrack(forceNext: Boolean = false): TrackInfo? {
        val current = getCurrentTrack()
        if (current != null && !forceNext) {
            if (repeatMode == "one") {
                return current
            }
        }
        if (current != null) {
            addToHistory(current)
        }

        return if (isShuffled) nextShuffled() else nextSequential()
    }

    private fun nextSequential(): TrackInfo? {
        val nextIdx = currentIndex + 1
        return if (nextIdx in queue.indices) {
            currentIndex = nextIdx
            queue[nextIdx]
        } else if (repeatMode == "all" && queue.isNotEmpty()) {
            currentIndex = 0
            queue[0]
        } else null
    }

    private fun nextShuffled(): TrackInfo? {
        // Find current queue-index position inside shuffleOrder, then advance
        val posInOrder = shuffleOrder.indexOf(currentIndex)
        if (posInOrder < 0) return null
        var nextPos = posInOrder + 1
        if (nextPos !in shuffleOrder.indices) {
            if (repeatMode == "all" && shuffleOrder.isNotEmpty()) {
                nextPos = 0
            } else {
                return null
            }
        }
        val nextQueueIdx = shuffleOrder[nextPos]
        currentIndex = nextQueueIdx
        return queue.getOrNull(nextQueueIdx)
    }

    @Synchronized
    fun previousTrack(): TrackInfo? {
        if (currentIndex - 1 >= 0) {
            currentIndex--
            return queue[currentIndex]
        }
        return null
    }

    @Synchronized
    fun hasNext(forceNext: Boolean = false): Boolean {
        if (repeatMode == "one" && !forceNext) return true
        if (repeatMode == "all" && queue.isNotEmpty()) return true
        return if (isShuffled) {
            shuffleOrder.indexOf(currentIndex) + 1 < shuffleOrder.size
        } else {
            currentIndex + 1 < queue.size
        }
    }

    @Synchronized
    fun clearQueue() {
        queue.clear()
        currentIndex = -1
        shuffleOrder.clear()
    }

    @Synchronized
    fun clearUpcoming() {
        val keepUntil = currentIndex.coerceAtLeast(-1) + 1
        while (queue.size > keepUntil) {
            queue.removeAt(queue.lastIndex)
        }
        if (isShuffled) {
            shuffleOrder.removeAll { it >= keepUntil }
        }
    }

    @Synchronized
    fun addToHistory(track: TrackInfo) {
        val key = track.key()
        sessionPlayed.add(track.id)
        history.removeAll { it == key }
        history.addFirst(key)
        if (history.size > MAX_HISTORY_SIZE) {
            history.removeLast()
        }
    }

    @Synchronized
    fun getHistory(): List<Pair<String, String>> = history.toList()

    @Synchronized
    fun getKnownTracks(): List<Pair<String, String>> {
        val known = ArrayList<Pair<String, String>>()
        known.addAll(queue.map { it.key() })
        known.addAll(history)
        return known.distinct()
    }

    @Synchronized
    fun isPlayedInSession(track: TrackInfo): Boolean {
        return sessionPlayed.contains(track.id)
    }

    @Synchronized
    fun getSessionPlayedCount(): Int = sessionPlayed.size

    @Synchronized
    fun toggleShuffle() {
        if (isShuffled) {
            isShuffled = false
            shuffleOrder.clear()
        } else {
            isShuffled = true
            shuffleOrder.clear()
            val current = currentIndex
            for (i in queue.indices) {
                if (i != current) shuffleOrder.add(i)
            }
            shuffleOrder.shuffle()
            shuffleOrder.add(0, current)
        }
    }

    @Synchronized
    fun isShuffleEnabled(): Boolean = isShuffled

    @Synchronized
    fun setRepeatMode(mode: String) {
        repeatMode = mode
    }

    @Synchronized
    fun getRepeatMode(): String = repeatMode

    @Synchronized
    fun queueSize(): Int = queue.size

    @Synchronized
    fun remainingInQueue(): Int {
        return if (currentIndex < 0) queue.size
        else queue.size - currentIndex - 1
    }

    @Synchronized
    fun needsAutoplayFill(): Boolean {
        return remainingInQueue() < MAX_AUTOPLAY_BUFFER
    }

    @Synchronized
    fun trimQueueTo(maxSize: Int) {
        while (queue.size > maxSize) {
            val lastIdx = queue.lastIndex
            if (lastIdx > currentIndex) {
                queue.removeAt(lastIdx)
            } else break
        }
    }
}

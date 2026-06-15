package com.msic.api

object ImageResolver {

    private const val FALLBACK_COVER = "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80"

    fun resolve(track: LastFmTrack): String {
        val fromImages = extractBestImage(track.images)
        if (fromImages.isNotEmpty()) return fromImages
        return FALLBACK_COVER
    }

    fun resolveArtist(artist: ArtistSearchResult): String {
        val fromImages = extractBestImage(artist.images)
        if (fromImages.isNotEmpty()) return fromImages
        return FALLBACK_COVER
    }

    fun resolveFromStrings(images: List<LastFmImage>?): String {
        val fromImages = extractBestImage(images)
        if (fromImages.isNotEmpty()) return fromImages
        return FALLBACK_COVER
    }

    fun extractBestImage(images: List<LastFmImage>?): String {
        if (images.isNullOrEmpty()) return ""

        val sizePrefs = listOf("mega", "extralarge", "large", "medium", "small")
        for (pref in sizePrefs) {
            val img = images.find { it.size == pref }
            val url = img?.url
            if (url != null && url.isNotEmpty() && !url.endsWith("/2a96cbd8b46e442fc41c2b86b821562f.png")) {
                return url
            }
        }

        for (img in images) {
            val url = img.url
            if (url != null && url.isNotEmpty() && !url.endsWith("/2a96cbd8b46e442fc41c2b86b821562f.png")) {
                return url
            }
        }

        return ""
    }

    fun extractBestImageOrFallback(images: List<LastFmImage>?): String {
        val extracted = extractBestImage(images)
        return extracted.ifEmpty { FALLBACK_COVER }
    }
}

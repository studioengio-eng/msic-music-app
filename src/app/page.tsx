'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Play, Pause, SkipBack, SkipForward,
  Search, Home as HomeIcon, Bookmark, User,
  X, Loader2, Link2, MessageSquare, Plus, Headphones,
  SlidersHorizontal, Settings, ListMusic, Trash2, ArrowLeft, Repeat, Repeat1, Shuffle, PlusCircle,
  Mic2, Cast, Bluetooth, Speaker, Smartphone, Volume2, ChevronLeft, ChevronRight, Music, MonitorSpeaker
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { fetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { searchYouTube } from './music-search';
import { resolveAudioUrl as ytResolveAudioUrl, initYtEngine } from './youtube-engine';
import {
  fetchPageHtml,
  parseAppleMusicPlaylist,
  parseSpotifyPlaylist,
  parseYouTubePlaylist,
  parseJsonLdPlaylist,
} from './playlist-import';
import s from './page.module.css';

// Import our custom Msic v1.4 Premium engines
import { fetchLyricsFromLrcLib, LyricLine, LyricWord } from './lyrics-engine';


interface Track {
  id: string;
  title: string;
  artist: string;
  cover: string;
  source?: string;
  videoId?: string;
  youtubeUrl?: string;
  duration?: number;
}

interface Playlist {
  id: string;
  title: string;
  cover: string;
  tracks: Track[];
}

/** Normalize text: remove accents, lowercase, trim */
const normalize = (text: string) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Maps a raw result to a Track, preserving videoId/youtubeUrl from YouTube search. */
const mapTrack = (v: any): Track => {
  const rawId = v.videoId || v.id || "";
  const isRealId = typeof rawId === 'string' && rawId.length > 0 && !rawId.startsWith('search:') && !rawId.startsWith('lastfm:');
  const ytUrl = v.youtubeUrl || (isRealId && (rawId.startsWith('http://') || rawId.startsWith('https://')) ? rawId : (isRealId && rawId.length === 11 ? `https://youtube.com/watch?v=${rawId}` : ""));
  
  return {
    id: isRealId ? rawId : (rawId.startsWith('search:') ? rawId : `search:${v.title || "Audio"}`),
    title: v.title || v.name || "Audio",
    artist: v.author || v.artist || v.uploaderName || "Desconocido",
    cover: v.thumbnail || v.cover || (isRealId && rawId.length === 11 ? ytThumbnail(rawId) : "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80"),
    videoId: isRealId ? rawId : undefined,
    youtubeUrl: ytUrl || undefined,
    duration: v.duration || 0,
  };
};

const ytThumbnail = (videoId: string) =>
  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

const isLegitTrack = (title: string, channelName: string): boolean => {
  const ch = normalize(channelName);
  const ti = normalize(title);
  const blocked = [
    'exitos', 'baladas', 'romanticas', 'romanticos', 'compilacion',
    'recopilacion', 'playlist', 'top hits', 'best of', 'greatest hits',
    'mix musical', 'las mejores', 'los mejores', 'musica del recuerdo',
    'musica romantica', 'viejitas pero bonitas', 'del ayer', 'del recuerdo',
    'lo mejor de la musica', 'canciones de amor', 'mix de', 'mega mix',
    'completo', 'full album', 'grandes exitos', 'enganchados', 'mix',
    '#shorts', '#short', 'shorts', 'tiktok', 'reel', 'meme', 'clip'
  ];
  return !blocked.some(pattern => ch.includes(pattern) || ti.includes(pattern));
};

const resolveLazyTrack = async (query: string, domain: string): Promise<string> => {
  // Ahora ya no necesitamos resolver el ID manualmente (evitamos errores de CORS)
  // Devolvemos el query directamente para que el motor de Embed lo use para buscar
  return `search:${query}`;
};

type RepeatMode = 'off' | 'all' | 'one';
const mapTrackResult = (item: { title: string; artist: string; cover: string; videoId?: string; youtubeUrl?: string; duration?: number }): Track => ({
  id: item.videoId || `track:${item.title} ${item.artist}`,
  title: item.title,
  artist: item.artist,
  cover: item.cover || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80',
  source: (item as { source?: string }).source,
  videoId: item.videoId,
  youtubeUrl: item.youtubeUrl,
  duration: item.duration,
});

const buildShuffleOrder = (length: number, currentIndex: number): number[] => {
  const rest = Array.from({ length }, (_, i) => i).filter((i) => i !== currentIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [currentIndex, ...rest];
};
export default function MusicApp() {
  const [activeView, setActiveView] = useState<'home' | 'search' | 'settings' | 'playlists' | 'playlist-details'>('home');
  const [isPlaying, setIsPlaying]   = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading]   = useState(false);

  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [allSearchResults, setAllSearchResults] = useState<Track[]>([]);
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreSearch, setHasMoreSearch] = useState(true);
  const [isSearchingMore, setIsSearchingMore] = useState(false);
  const searchSentinelRef = useRef<HTMLDivElement>(null);
  const [recentTracks, setRecentTracks]   = useState<Track[]>([]);
  const [savedPlaylists, setSavedPlaylists] = useState<Playlist[]>([]);
  const [activePlaylist, setActivePlaylist] = useState<Playlist | null>(null);

  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const [isMiniExpanded, setIsMiniExpanded] = useState(false);
  const [lyricsOffset, setLyricsOffset] = useState(0);
  const [progress, setProgress]     = useState(0);

  // Premium v1.4 State Variables
  const [extractedColors, setExtractedColors] = useState<string[]>(['#1e1e24', '#0f0c1b', '#140101']);

  // Playlist import modal
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [showCreatePlaylistModal, setShowCreatePlaylistModal] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [playbackQueue, setPlaybackQueue] = useState<Track[]>([]);
  const [trackEndedFlag, setTrackEndedFlag] = useState(0);
  const [duration, setDuration] = useState(0); // en ms
  const [currentTime, setCurrentTime] = useState(0); // en ms
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [isShuffle, setIsShuffle] = useState(false);

  // Letras (Lyrics)
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [lyricsPlain, setLyricsPlain] = useState('');
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const activeLyricRef = useRef<HTMLDivElement>(null);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);

  // Selector de dispositivo
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const [castDevices, setCastDevices] = useState<{ id: string; name: string; type: 'phone' | 'bt' | 'cast' }[]>([]);
  const [pairedDevices, setPairedDevices] = useState<{ name: string; address: string; isActive: boolean }[]>([]);
  const [activeDeviceType, setActiveDeviceType] = useState<string>('BUILT_IN_SPEAKER');

  // --- MOTOR DE AUDIO WEB (Para PC) ---
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const userPausedRef = useRef(false);
  const usingNativePlayerRef = useRef(false);
  const playbackQueueRef = useRef<Track[]>([]);
  const queueIndexRef = useRef(0);
  const shuffleOrderRef = useRef<number[] | null>(null);
  const shufflePosRef = useRef(0);
  const playedInSessionRef = useRef<Set<string>>(new Set());
  const nativeEndedHandledRef = useRef(false);
  const advancingRef = useRef(false);
  const repeatModeRef = useRef<RepeatMode>('off');
  const isShuffleRef = useRef(false);
  const queueModeRef = useRef<'playlist' | 'radio'>('radio');
  const activeViewRef = useRef(activeView);
  const searchExcludeIdsRef = useRef<Set<string>>(new Set());
  const RADIO_BUFFER_SIZE = 3;
  const REFILL_BEFORE_END_MS = 55_000;

  // Safe area insets syncing (preserves properties across Next.js hydration)
  useEffect(() => {
    const applySafeInsets = (top: number, bottom: number) => {
      document.documentElement.style.setProperty('--safe-area-inset-top', `${top}px`);
      document.documentElement.style.setProperty('--safe-area-inset-bottom', `${bottom}px`);
    };

    const w = window as any;
    w.setSafeAreaInsets = (top: number, bottom: number) => {
      w.safeAreaInsetTop = top;
      w.safeAreaInsetBottom = bottom;
      applySafeInsets(top, bottom);
    };

    if (typeof w.safeAreaInsetTop === 'number' && typeof w.safeAreaInsetBottom === 'number') {
      applySafeInsets(w.safeAreaInsetTop, w.safeAreaInsetBottom);
    }
  }, []);

  type RadioQueueItem = { track: Track; url: string; thumbnail?: string };
  const radioQueueRef = useRef<RadioQueueItem[]>([]);
  const radioQueuedIdsRef = useRef<Set<string>>(new Set());
  const fillingRadioRef = useRef(false);
  const currentTrackRef = useRef<Track | null>(null);
  const prefetchedRadioRef = useRef<RadioQueueItem | null>(null);
  const recentRadioArtistsRef = useRef<string[]>([]);
  const streamCacheRef = useRef<Map<string, { url: string; thumbnail?: string; expiresAt: number }>>(new Map());
  const streamPendingRef = useRef<Map<string, Promise<{ url: string; thumbnail?: string }>>>(new Map());
  const playGenerationRef = useRef(0);
  const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloadGenerationRef = useRef(0);
  const fillGenerationRef = useRef(0);
  const lyricsGenerationRef = useRef(0);

  const STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
  const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

  const getStreamKey = (track: Track) => `${track.videoId || ''}\0${track.title}\0${track.artist}`;

  const getCachedStream = (key: string): { url: string; thumbnail?: string } | null => {
    const cached = streamCacheRef.current.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expiresAt) {
      streamCacheRef.current.delete(key);
      return null;
    }
    return { url: cached.url, thumbnail: cached.thumbnail };
  };

  const cacheStream = (key: string, stream: { url: string; thumbnail?: string }) => {
    streamCacheRef.current.set(key, {
      ...stream,
      expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
    });
  };

  const invalidateStreamCache = (track: Track) => {
    streamCacheRef.current.delete(getStreamKey(track));
  };

  const isTauriMobile = () =>
    typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  const isAndroidRuntime = () =>
    typeof window !== 'undefined' && navigator.userAgent.toLowerCase().includes('android');

  const resolveStreamUrl = async (track: Track): Promise<{ url: string; thumbnail?: string }> => {
    const query = `${track.title} ${track.artist}`;
    const key = getStreamKey(track);
    const cached = getCachedStream(key);
    if (cached) return cached;

    const pending = streamPendingRef.current.get(key);
    if (pending) return pending;

    const isAndroid = isAndroidRuntime();

    const resolveViaNative = async (): Promise<{ url: string; thumbnail?: string } | null> => {
      let url = '';
      const isYt = track.videoId && YOUTUBE_ID_RE.test(track.videoId);
      let thumbnail: string | undefined = isYt ? ytThumbnail(track.videoId!) : (track.cover || undefined);
      const ytUrlArg =
        track.youtubeUrl ||
        (track.videoId && (track.videoId.startsWith('http') || isYt) ? track.videoId : '');
      
      if (isAndroid) {
        try {
          const result = await invoke<{ url: string; thumbnail?: string }>('plugin:player|getAudioUrl', {
            query,
            youtubeUrl: ytUrlArg,
          });
          url = result.url;
          thumbnail = result.thumbnail || thumbnail;
        } catch (err) {
          console.warn('[Native Resolver] plugin getAudioUrl failed on Android:', err);
        }
      } else {
        if (isTauriMobile()) {
          try {
            const result = await invoke<{ url: string; thumbnail?: string }>('plugin:player|getAudioUrl', {
              query: track.videoId || query,
              youtubeUrl: ytUrlArg,
            });
            url = result.url;
            thumbnail = result.thumbnail || thumbnail;
          } catch {
            url = await invoke<string>('get_audio_url', { query: track.videoId || query });
          }
        } else {
          try {
            url = track.videoId && isYt
              ? await invoke<string>('resolve_optimized_stream', { videoId: track.videoId })
              : await invoke<string>('get_audio_url', { query });
          } catch {
            const result = await invoke<{ url: string; thumbnail?: string }>('plugin:player|getAudioUrl', {
              query: track.videoId || query,
              youtubeUrl: ytUrlArg,
            });
            url = result.url;
            thumbnail = result.thumbnail || thumbnail;
          }
        }
      }
      if (url && !url.startsWith('blob:')) {
        return { url, thumbnail };
      }
      return null;
    };

    const task = (async () => {
      const isYt = track.videoId && YOUTUBE_ID_RE.test(track.videoId);
      let thumbnail: string | undefined = isYt ? ytThumbnail(track.videoId!) : (track.cover || undefined);

      if (isAndroid) {
        const native = await resolveViaNative();
        if (native) {
          cacheStream(key, native);
          return native;
        }
      } else {
        if (track.videoId && isYt) {
          const [webUrl, native] = await Promise.all([
            ytResolveAudioUrl(track.videoId).catch(() => null),
            resolveViaNative(),
          ]);
          const winner =
            (webUrl && !webUrl.startsWith('blob:') ? { url: webUrl, thumbnail } : null) ||
            native;
          if (winner) {
            cacheStream(key, winner);
            return winner;
          }
        } else {
          const native = await resolveViaNative();
          if (native) {
            cacheStream(key, native);
            return native;
          }
        }

        const retry = await resolveViaNative();
        if (retry) {
          cacheStream(key, retry);
          return retry;
        }
      }
      throw new Error('No se pudo obtener el stream de audio');
    })();

    streamPendingRef.current.set(key, task);
    try {
      return await task;
    } finally {
      streamPendingRef.current.delete(key);
    }
  };

  const prefetchStream = async (track: Track | null, delayMs?: number) => {
    const waitMs = delayMs ?? (track?.videoId ? 0 : 40);
    preloadGenerationRef.current += 1;
    const generation = preloadGenerationRef.current;
    if (preloadTimerRef.current) {
      clearTimeout(preloadTimerRef.current);
      preloadTimerRef.current = null;
    }
    if (!track) return;

    preloadTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          if (generation !== preloadGenerationRef.current) return;
          const stream = await resolveStreamUrl(track);
          if (generation !== preloadGenerationRef.current) return;
          if (stream && isTauriMobile() && stream.url) {
            await invoke('plugin:player|setRadioPrefetch', {
              url: stream.url,
              title: track.title,
              artist: track.artist,
              thumbnail: stream.thumbnail || track.cover || '',
            }).catch(() => {});
          }
        } catch {
          // Preload must never break current playback.
        }
      })();
    }, waitMs);
  };

  const cancelSecondaryTasks = () => {
    preloadGenerationRef.current += 1;
    fillGenerationRef.current += 1;
    if (preloadTimerRef.current) {
      clearTimeout(preloadTimerRef.current);
      preloadTimerRef.current = null;
    }
    fillingRadioRef.current = false;
  };

  const buildRadioExcludeIds = (): Set<string> => {
    const exclude = new Set(playedInSessionRef.current);
    searchExcludeIdsRef.current.forEach((id) => exclude.add(id));
    playbackQueueRef.current.forEach((t) => exclude.add(t.id));
    return exclude;
  };

  const trackIdentityKeys = (track: Track): string[] => [
    track.id,
    track.videoId || '',
    track.youtubeUrl || '',
    `${normalize(track.title)}::${normalize(track.artist)}`,
  ].filter(Boolean);

  const stopCurrentPlaybackNow = async () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }

    await Promise.allSettled([
      invoke('plugin:player|pausePlayback'),
      invoke('player_stop'),
    ]);

    if ((window as any).MediaEngine) {
      (window as any).MediaEngine.updatePlaybackState(false);
    }
    setIsPlaying(false);
  };

  type RadioPools = {
    sameArtist: Track[];
    related: Track[];
  };

  const AUTOPLAY_BLOCKED_TERMS = [
    'remix', 'nightcore', 'slowed', 'sped up', 'podcast', 'reaction', 'live',
    'bass boosted', '8d audio', 'karaoke', 'cover', 'shorts', 'tiktok',
    'meme', 'full album', 'compilation', 'playlist', 'mix', 'radio',
    'nonstop', 'non-stop', 'full concert', 'album', 'greatest hits', 'best of',
    'collection', '1 hour', '2 hour', 'hour', 'extended', 'loop', 'lofi',
  ];

  const isBadAutoplayTrack = (track: Track) => {
    const text = normalize(`${track.title} ${track.artist}`);
    if (!track.videoId && !track.youtubeUrl && !track.id) return true;
    if (track.duration && (track.duration < 45 || track.duration > 540)) return true;
    return AUTOPLAY_BLOCKED_TERMS.some((term) => text.includes(term));
  };

  const artistStreak = (artist: string, recentArtists: string[]) => {
    const target = normalize(artist);
    let streak = 0;
    for (const recent of recentArtists) {
      if (recent === target) streak++;
      else break;
    }
    return streak;
  };

  const scoreAutoplayCandidate = (
    anchor: Track,
    candidate: Track,
    recentArtists: string[],
  ) => {
    const anchorArtist = normalize(anchor.artist);
    const candidateArtist = normalize(candidate.artist);
    const anchorTitle = normalize(anchor.title);
    const candidateTitle = normalize(candidate.title);
    const sameTitleAndArtist = candidateTitle === anchorTitle && candidateArtist === anchorArtist;
    if (candidate.id === anchor.id || sameTitleAndArtist || isBadAutoplayTrack(candidate)) return -999;

    let score = 50;
    const sameArtist =
      candidateArtist === anchorArtist ||
      candidateArtist.includes(anchorArtist) ||
      anchorArtist.includes(candidateArtist);
    if (sameArtist) score += 35;
    else score -= 8;

    const streak = artistStreak(candidate.artist, recentArtists);
    if (streak >= 2) return -999;
    if (streak === 1) score -= 45;

    if (anchor.duration && candidate.duration) {
      const diff = Math.abs(anchor.duration - candidate.duration);
      if (diff <= 20) score += 16;
      else if (diff <= 45) score += 10;
      else if (diff <= 90) score += 4;
      else score -= 8;
    }

    if (candidateTitle === anchorTitle) score -= 30;
    if (candidate.videoId) score += 14;
    if (candidate.youtubeUrl) score += 8;
    if (candidate.cover) score += 4;
    return score;
  };

  const fetchRadioPools = async (
    anchor: Track,
    excludeIds: Set<string>,
  ): Promise<RadioPools> => {
    const artistNorm = normalize(anchor.artist);
    const titleNorm = normalize(anchor.title);

    const sameArtist: Track[] = [];
    const related: Track[] = [];

    const searchYtBatch = async (query: string, limit = 20): Promise<void> => {
      try {
        const items = await searchYouTube(query, limit, 1);
        for (const item of items) {
          const t = mapTrackResult(item);
          const keys = trackIdentityKeys(t);
          if (keys.some((key) => excludeIds.has(key))) continue;
          if (isBadAutoplayTrack(t)) continue;
          const itemArtist = normalize(t.artist);
          const itemTitle = normalize(t.title);
          if (itemArtist === artistNorm && itemTitle !== titleNorm) {
            sameArtist.push(t);
          } else {
            related.push(t);
          }
        }
      } catch {
        /* siguiente */
      }
    };

    await searchYtBatch(`${anchor.artist} ${anchor.title}`, 20);

    if (sameArtist.length < 5) {
      await searchYtBatch(`${anchor.artist} songs`, 20);
    }

    if (sameArtist.length < 8) {
      const artistQueries = [
        `${anchor.artist} official audio`,
        `${anchor.artist} topic`,
      ];
      for (const q of artistQueries) {
        if (sameArtist.length >= 12) break;
        await searchYtBatch(q, 20);
      }
    }

    const dedupe = (list: Track[]) =>
      Array.from(new Map(list.map((t) => [t.id, t])).values());

    return {
      sameArtist: dedupe(sameArtist),
      related: dedupe(related),
    };
  };

  const fetchITunesRadio = async (artistName: string): Promise<Track[]> => {
    try {
      let cleanArtist = artistName
        .replace(/ - Topic$/i, '')
        .replace(/ VEVO$/i, '')
        .replace(/\(feat\..*?\)/i, '')
        .replace(/feat\..*/i, '')
        .trim();
        
      if (!cleanArtist) cleanArtist = artistName;

      const q = encodeURIComponent(cleanArtist);
      const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=song&attribute=artistTerm&limit=50`);
      if (!res.ok) return [];
      const json = await res.json();
      if (!json.results || json.results.length === 0) return [];

      const tracks: Track[] = [];

      for (const t of json.results) {
        if (!t.trackName || !t.artistName) continue;
        const cover = (t.artworkUrl100 || '').replace('100x100bb.jpg', '500x500bb.jpg');
        tracks.push({
          id: `track:${normalize(t.trackName)} ${normalize(t.artistName)}`,
          title: t.trackName,
          artist: t.artistName,
          duration: Math.floor((t.trackTimeMillis || 0) / 1000),
          cover: cover || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80',
        });
      }

      // Shuffle tracks for a diverse radio mix
      return tracks
        .map(value => ({ value, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ value }) => value);
    } catch (e) {
      console.error('iTunes Radio error:', e);
      return [];
    }
  };

  const pickDiverseRadioTracks = async (
    anchor: Track,
    count: number,
    excludeIds: Set<string>,
  ): Promise<Track[]> => {
    
    const picked: Track[] = [];
    const seenTitles = new Set<string>();
    seenTitles.add(normalize(anchor.title));

    const tryArtist = async (artist: string) => {
      const itunesTracks = await fetchITunesRadio(artist);
      for (const t of itunesTracks) {
        if (picked.length >= count) break;
        const normTitle = normalize(t.title);
        
        if (excludeIds.has(t.id)) continue;
        if (seenTitles.has(normTitle)) continue;
        
        seenTitles.add(normTitle);
        picked.push(t);
        excludeIds.add(t.id);
      }
    };

    // 1. Try Anchor Artist
    await tryArtist(anchor.artist);

    // 2. Pivot to recent radio artists if needed
    if (picked.length < count) {
      const recentArtists = recentRadioArtistsRef.current;
      for (const fallbackArtist of recentArtists) {
        if (picked.length >= count) break;
        if (normalize(fallbackArtist) === normalize(anchor.artist)) continue;
        await tryArtist(fallbackArtist);
      }
    }

    return picked;
  };

  const rememberRadioArtist = (track: Track) => {
    const a = normalize(track.artist);
    recentRadioArtistsRef.current = [a, ...recentRadioArtistsRef.current].slice(0, 8);
  };

  const fetchSimilarTrack = async (anchor: Track, excludeIds: Set<string>): Promise<Track | null> => {
    const picked = await pickDiverseRadioTracks(anchor, 1, new Set(excludeIds));
    return picked[0] ?? null;
  };

  const pushRadioQueueToNative = async (queue: RadioQueueItem[]) => {
    if (!isTauriMobile() || queue.length === 0) return;
    try {
      await invoke('plugin:player|setRadioQueue', {
        itemsJson: JSON.stringify(
          queue.map((q) => ({
            url: q.url,
            title: q.track.title,
            artist: q.track.artist,
            thumbnail: q.thumbnail || q.track.cover || '',
            duration: q.track.duration || 0,
          })),
        ),
      });
    } catch {
      try {
        const head = queue[0];
        await invoke('plugin:player|setRadioPrefetch', {
          url: head.url,
          title: head.track.title,
          artist: head.track.artist,
          thumbnail: head.thumbnail || head.track.cover || '',
        });
      } catch {
        /* ignore */
      }
    }
  };

  const pushPlaylistQueueToNative = async (queue: Track[], currentIndex: number) => {
    if (!isTauriMobile() || queue.length === 0) return;
    try {
      let upcoming: Track[] = [];
      if (shuffleOrderRef.current && queue.length > 1) {
        const startPos = shufflePosRef.current + 1;
        for (let p = startPos; p < shuffleOrderRef.current.length; p++) {
          const idx = shuffleOrderRef.current[p];
          if (queue[idx]) {
            upcoming.push(queue[idx]);
          }
        }
      } else {
        upcoming = queue.slice(currentIndex + 1);
      }

      await invoke('plugin:player|setPlaylistQueue', {
        itemsJson: JSON.stringify(
          upcoming.map((t) => ({
            url: t.youtubeUrl || (t.videoId ? `https://www.youtube.com/watch?v=${t.videoId}` : ''),
            title: t.title,
            artist: t.artist,
            thumbnail: t.cover || '',
            duration: t.duration || 0,
          })),
        ),
      });
    } catch (e) {
      console.error("[Player] Error pushing playlist queue to native:", e);
    }
  };

  const clearNativeRadioPrefetch = () => {
    if (!isTauriMobile()) return;
    void invoke('plugin:player|clearRadioPrefetch').catch(() => {});
  };

  const syncRadioQueueMirror = () => {
    prefetchedRadioRef.current = radioQueueRef.current[0] ?? null;
  };

  const fillRadioQueue = (anchor: Track | null, force = false) => {
    if (!anchor) return;
    if (isTauriMobile()) {
      void invoke('plugin:player|fillAutoplayQueue').catch(() => {});
      return;
    }
    const generation = ++fillGenerationRef.current;
    void (async () => {
      if (fillingRadioRef.current) return;
      const need = RADIO_BUFFER_SIZE - radioQueueRef.current.length;
      const batchSize = Math.min(RADIO_BUFFER_SIZE, need);
      if (batchSize <= 0) return;

      fillingRadioRef.current = true;
      try {
        await new Promise((resolve) => setTimeout(resolve, force ? 20 : 80));
        if (generation !== fillGenerationRef.current) return;

        const exclude = buildRadioExcludeIds();
        radioQueueRef.current.forEach((q) => exclude.add(q.track.id));
        radioQueuedIdsRef.current.forEach((id) => exclude.add(id));

        const candidates = await pickDiverseRadioTracks(anchor, batchSize + 4, exclude);
        if (candidates.length === 0) return;
        if (generation !== fillGenerationRef.current) return;

        const maxResolve = Math.min(candidates.length, batchSize);
        const candidatesToResolve = candidates.slice(0, maxResolve);

        const resolved = await Promise.all(
          candidatesToResolve.map(async (track) => {
            try {
              const stream = await resolveStreamUrl(track);
              if (stream.url && !stream.url.startsWith('blob:')) {
                return { track, url: stream.url, thumbnail: stream.thumbnail };
              }
            } catch {
              /* siguiente */
            }
            return null;
          }),
        );
        if (generation !== fillGenerationRef.current) return;

        let addedCount = 0;
        for (const item of resolved) {
          if (!item) continue;
          if (radioQueueRef.current.length >= RADIO_BUFFER_SIZE) break;
          if (addedCount >= batchSize) break;
          if (
            radioQueueRef.current.some((q) => q.track.id === item.track.id) ||
            radioQueuedIdsRef.current.has(item.track.id)
          ) {
            continue;
          }
          radioQueueRef.current.push(item);
          radioQueuedIdsRef.current.add(item.track.id);
          addedCount++;
        }

        syncRadioQueueMirror();
        await pushRadioQueueToNative(radioQueueRef.current);
      } catch {
        /* ignore */
      } finally {
        fillingRadioRef.current = false;
      }
    })();
  };

  const consumeRadioQueueHeadIfMatch = (track: Track): RadioQueueItem | null => {
    const head = radioQueueRef.current[0];
    if (head && head.track.id === track.id) {
      radioQueueRef.current.shift();
      radioQueuedIdsRef.current.delete(track.id);
      syncRadioQueueMirror();
      return head;
    }
    return null;
  };

  const syncFromNativePlayback = async () => {
    if (!isTauriMobile()) return;
    try {
      const np = await invoke<{ title: string; artist: string }>(
        'plugin:player|getNowPlaying',
      );
      if (!np.title?.trim()) return;

      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      let matched = false;

      while (radioQueueRef.current.length > 0) {
        const head = radioQueueRef.current[0];
        if (
          norm(head.track.title) === norm(np.title) &&
          norm(head.track.artist) === norm(np.artist)
        ) {
          const item = radioQueueRef.current.shift()!;
          radioQueuedIdsRef.current.delete(item.track.id);
          playedInSessionRef.current.add(item.track.id);
          setCurrentTrack(item.track);
          setIsPlaying(true);
          usingNativePlayerRef.current = true;
          matched = true;
          queueModeRef.current = 'radio';
          fillRadioQueue(item.track, true);
          break;
        }
        break;
      }

      if (!matched) {
        setCurrentTrack((t) =>
          t ? { ...t, title: np.title, artist: np.artist } : t,
        );
        const anchor = currentTrackRef.current;
        if (anchor) fillRadioQueue(anchor, true);
      }

      syncRadioQueueMirror();
      await pushRadioQueueToNative(radioQueueRef.current);
    } catch {
      /* ignore */
    }
  };

  const syncQueueForTrack = (
    track: Track,
    queueContext: Track[],
    shuffle: boolean,
    mode: 'playlist' | 'radio' = 'radio',
  ) => {
    queueModeRef.current = mode;

    let queue: Track[];
    if (mode === 'playlist') {
      queue = queueContext.length > 0 ? [...queueContext] : [track];
    } else {
      const prev = playbackQueueRef.current;
      const idx = prev.findIndex((t) => t.id === track.id);
      queue = idx >= 0 ? prev : [...prev, track];
    }

    setPlaybackQueue(queue);
    playbackQueueRef.current = queue;
    const idx = queue.findIndex((t) => t.id === track.id);
    queueIndexRef.current = idx >= 0 ? idx : 0;

    if (mode === 'playlist' && shuffle && queue.length > 1) {
      shuffleOrderRef.current = buildShuffleOrder(queue.length, queueIndexRef.current);
      shufflePosRef.current = 0;
    } else {
      shuffleOrderRef.current = null;
      shufflePosRef.current = 0;
    }
  };

  useEffect(() => {
    playbackQueueRef.current = playbackQueue;
  }, [playbackQueue]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    searchExcludeIdsRef.current = new Set(searchResults.map((t) => t.id));
  }, [searchResults]);

  useEffect(() => {
    repeatModeRef.current = repeatMode;
    if (audioRef.current) {
      audioRef.current.loop = (repeatMode === 'one');
    }
    if (isTauriMobile()) {
      void invoke('plugin:player|setRepeatMode', { mode: repeatMode }).catch(() => {});
    }
  }, [repeatMode]);

  useEffect(() => {
    isShuffleRef.current = isShuffle;
  }, [isShuffle]);

  useEffect(() => {
    currentTrackRef.current = currentTrack;
  }, [currentTrack]);

  // ─── Dynamic Color Extraction Utility ───
  const extractArtworkColors = (imgUrl: string): Promise<string[]> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.src = imgUrl;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 5;
        canvas.height = 5;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(['#1e1e24', '#0f0c1b', '#140101']);
        ctx.drawImage(img, 0, 0, 5, 5);
        const data = ctx.getImageData(0, 0, 5, 5).data;
        const colors = new Set<string>();
        for (let i = 0; i < data.length; i += 8) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
          colors.add(hex);
        }
        resolve(Array.from(colors).slice(0, 4));
      };
      img.onerror = () => {
        resolve(['#1e1e24', '#0f0c1b', '#140101']);
      };
    });
  };

  // ─── Synced Lyrics & Translation Loader ───
  const fetchLyrics = async (track: Track) => {
    const generation = ++lyricsGenerationRef.current;
    setLyricsLoading(true);
    setLyrics([]);
    setLyricsPlain('');
    setLyricsOffset(0);
    try {
      const data = await fetchLyricsFromLrcLib(track.title, track.artist);
      if (generation !== lyricsGenerationRef.current) return;
      if (data) {
        setLyrics(data.lines);
        setLyricsPlain(data.plainText);
      }
    } catch (e) {
      console.warn("Fetch lyrics failed", e);
    } finally {
      if (generation === lyricsGenerationRef.current) {
        setLyricsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (currentTrack) {
      fetchLyrics(currentTrack);
      
      // A. Dynamic artwork-reactive mesh colors
      if (currentTrack.cover) {
        const colorGeneration = lyricsGenerationRef.current;
        extractArtworkColors(currentTrack.cover).then((colors) => {
          if (colorGeneration === lyricsGenerationRef.current && colors.length > 0) {
            setExtractedColors(colors);
          }
        });
      }


    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id]);

  // Scroll automático a la letra activa sin forzar scroll del cuerpo
  useEffect(() => {
    if (showLyrics && activeLyricRef.current && lyricsContainerRef.current) {
      const container = lyricsContainerRef.current;
      const element = activeLyricRef.current;
      const offsetTop = element.offsetTop;
      const halfContainer = container.clientHeight / 2;
      const halfElement = element.clientHeight / 2;
      container.scrollTo({
        top: offsetTop - halfContainer + halfElement,
        behavior: 'smooth'
      });
    }
  }, [currentTime, showLyrics]);

  const requestBtPermission = async () => {
    if (!isTauriMobile()) return true;
    try {
      const res = await invoke<{ granted: boolean }>('plugin:player|requestBluetoothPermission');
      return res?.granted === true;
    } catch {
      return false;
    }
  };

  const openDevicePicker = async () => {
    setShowDevicePicker(true);
    if (isTauriMobile()) {
      await requestBtPermission();
      try {
        const [deviceRes, btRes] = await Promise.all([
          invoke<{ name: string; type: string; isActive: boolean }>('plugin:player|getActiveAudioDevice'),
          invoke<{ devices: { name: string; address: string; isActive: boolean }[] }>('plugin:player|getPairedBluetoothDevices'),
        ]);
        setActiveDeviceType(deviceRes?.type || 'BUILT_IN_SPEAKER');
        if (btRes?.devices) {
          setPairedDevices(btRes.devices);
        }
      } catch (err) {
        console.error('Error fetching bluetooth devices:', err);
      }
    }
  };

  useEffect(() => {
    // 1. Polling: ExoPlayer (Android) o MediaEngine legacy
    const interval = setInterval(async () => {
      if (usingNativePlayerRef.current) {
        try {
          const state: { position: number; duration: number; isPlaying: boolean } =
            await invoke('plugin:player|getPlaybackProgress');
          const dur = Number(state.duration) || 0;
          const cur = Number(state.position) || 0;
          if (dur > 0) {
            setCurrentTime(cur);
            setDuration(dur);
            setProgress((cur / dur) * 100);

            const isEndOfPlaylist = queueModeRef.current === 'playlist' && !hasNextInQueue();
            if (
              (queueModeRef.current === 'radio' || isEndOfPlaylist) &&
              currentTrackRef.current &&
              radioQueueRef.current.length < RADIO_BUFFER_SIZE
            ) {
              fillRadioQueue(currentTrackRef.current);
            }

            // Eliminamos el trigger por polling de trackEndedFlag en Android nativo.
            // Ahora dependemos 100% del evento msic-playback-ended que viene de Kotlin
            // para evitar que se dispare dos veces (doble salto de canción).
            if (state.isPlaying || cur < dur - 4000) {
              nativeEndedHandledRef.current = false;
            }
          }
          setIsPlaying(state.isPlaying);
        } catch {
          /* controller aún no listo */
        }
        return;
      }
      if ((window as any).MediaEngine) {
        const cur = (window as any).MediaEngine.getProgress();
        const dur = (window as any).MediaEngine.getDuration();
        if (dur > 0) {
          setCurrentTime(cur);
          setDuration(dur);
          setProgress((cur / dur) * 100);
        }
      }
    }, 500);

    // 2. Setup Audio Web (PC)
    audioRef.current = new Audio();
    audioRef.current.addEventListener('ended', () => {
      setTrackEndedFlag(prev => prev + 1);
    });
    
    const updateProgress = () => {
      if (audioRef.current && isFinite(audioRef.current.duration) && audioRef.current.duration > 0 && isFinite(audioRef.current.currentTime)) {
        const cur = audioRef.current.currentTime * 1000;
        const dur = audioRef.current.duration * 1000;
        setCurrentTime(cur);
        setDuration(dur);
        setProgress((cur / dur) * 100);

        const isEndOfPlaylist = queueModeRef.current === 'playlist' && !hasNextInQueue();
        if (
          (queueModeRef.current === 'radio' || isEndOfPlaylist) &&
          currentTrackRef.current &&
          radioQueueRef.current.length < RADIO_BUFFER_SIZE
        ) {
          fillRadioQueue(currentTrackRef.current);
        }
      }
    };
    audioRef.current.addEventListener('timeupdate', updateProgress);

    return () => {
      clearInterval(interval);
      cancelSecondaryTasks();
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const [showAddToPlaylistModal, setShowAddToPlaylistModal] = useState(false);

  const [homeRecommendations, setHomeRecommendations] = useState<Track[]>([]);
  const [isFetchingRecs, setIsFetchingRecs] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const timerRef  = useRef<any>(null);

  useEffect(() => {
    const history: Track[] = JSON.parse(localStorage.getItem('play-history') || '[]');
    setRecentTracks(history);

    const playlists: Playlist[] = JSON.parse(localStorage.getItem('saved-playlists') || '[]');
    setSavedPlaylists(playlists);



    // --- DIAGNÓSTICO DE PUENTE ---
    // Solo loggear en consola; no interrumpir al usuario con un alert.
    // MediaEngine puede no estar disponible en PC o en la primera carga.
    setTimeout(() => {
      if ((window as any).MediaEngine) {
        console.log("✅ Motor nativo detectado.");
      } else {
        console.warn("ℹ️ Motor nativo no detectado (normal en PC/web). Se usará el motor de audio HTML5.");
      }
    }, 2000);

    // --- Inicializar youtubei.js ---
    if (typeof window !== 'undefined') {
      initYtEngine().catch(() => {});
    }

    // --- PARCHE DE VISIBILIDAD ---
    // Engaña a la Page Visibility API para que siempre diga "visible"
    try {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true, writable: false });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: false });
    } catch (e) {}

    // Bloquear TODOS los eventos de visibilidad antes de que YouTube los reciba
    const blockVisibility = (e: Event) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    document.addEventListener('visibilitychange', blockVisibility, true);
    window.addEventListener('visibilitychange', blockVisibility, true);
    document.addEventListener('webkitvisibilitychange', blockVisibility, true);
    
    return () => {
      clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', blockVisibility, true);
      window.removeEventListener('visibilitychange', blockVisibility, true);
      document.removeEventListener('webkitvisibilitychange', blockVisibility, true);
    };
  }, []);



  const fetchHomeRecommendations = async (history: Track[]) => {
    if (history.length === 0) {
      setHomeRecommendations([]);
      return;
    }
    setIsFetchingRecs(true);
    try {
      const playedIds = new Set(history.map((t) => t.id));
      const artists = [...new Set(history.map((t) => t.artist).filter(Boolean))].slice(0, 4);
      const collected: Track[] = [];
      for (const artist of artists) {
        try {
          const items = await searchYouTube(artist, 15, 1);
          const batch: Track[] = items
            .map(mapTrackResult)
            .filter((t: Track) => !playedIds.has(t.id));
          collected.push(...batch);
        } catch {
          /* siguiente */
        }
      }
      const unique = Array.from(new Map(collected.map((t) => [t.id, t])).values());
      for (let i = unique.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unique[i], unique[j]] = [unique[j], unique[i]];
      }
      setHomeRecommendations(unique.slice(0, 24));
    } catch {
      setHomeRecommendations([]);
    } finally {
      setIsFetchingRecs(false);
    }
  };

  useEffect(() => {
    fetchHomeRecommendations(recentTracks);
  }, [recentTracks]);

  const createPlaylist = () => {
    const title = newPlaylistName.trim();
    if (!title) {
      showToast('Escribe un nombre para la playlist');
      return;
    }
    const newPlaylist: Playlist = {
      id: Date.now().toString(),
      title,
      cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80',
      tracks: [],
    };
    const updated = [newPlaylist, ...savedPlaylists];
    localStorage.setItem('saved-playlists', JSON.stringify(updated));
    setSavedPlaylists(updated);
    setNewPlaylistName('');
    setShowCreatePlaylistModal(false);
    showToast('Playlist creada');
  };

  const resetApp = () => {
    const confirmReset = window.confirm('¿Estás seguro? Esto borrará todas tus playlists, historial y configuraciones permanentemente.');
    if (confirmReset) {
      localStorage.clear();
      window.location.reload();
    }
  };

  const importYouTubePlaylistNative = async (
    url: string,
  ): Promise<{ title: string; tracks: Track[] } | null> => {
    if (!isTauriMobile()) return null;
    try {
      const result = await invoke<{
        title: string;
        tracks: { id: string; title: string; artist: string; thumbnail?: string }[];
      }>('plugin:player|importYouTubePlaylist', { query: url });
      if (!result.tracks?.length) return null;
      return {
        title: result.title || 'Playlist YouTube',
        tracks: result.tracks.map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          cover:
            t.thumbnail ||
            `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`,
        })),
      };
    } catch {
      return null;
    }
  };

  const importPlaylist = async () => {
    if (!playlistUrl.trim()) return;

    let url = playlistUrl.trim();
    if (!url.startsWith('http')) url = `https://${url}`;

    setIsImporting(true);
    let tracks: Track[] = [];
    let playlistTitle = 'Nueva Playlist';

    try {
      if (url.includes('music.apple.com')) {
        const parsed = await parseAppleMusicPlaylist(url);
        playlistTitle = parsed.title;
        tracks = parsed.tracks;
      } else if (
        url.includes('youtube.com') ||
        url.includes('youtu.be') ||
        url.includes('music.youtube.com')
      ) {
        const native = await importYouTubePlaylistNative(url);
        const parsed = native ?? (await parseYouTubePlaylist(url));
        playlistTitle = parsed.title;
        tracks = parsed.tracks;
      } else if (url.includes('spotify.com')) {
        const parsed = await parseSpotifyPlaylist(url);
        playlistTitle = parsed.title;
        tracks = parsed.tracks;
      } else {
        const html = await fetchPageHtml(url);
        const jsonLd = await parseJsonLdPlaylist(html);
        if (jsonLd) {
          playlistTitle = jsonLd.title;
          tracks = jsonLd.tracks;
        }
        if (tracks.length === 0) {
          const domBase = atob('eW91dHViZS5jb20=');
          const domShort = atob('eW91dHUuYmU=');
          const ytRegex = new RegExp(
            `(?:${domBase}/watch\\?v=|${domShort}/|${domBase}/embed/)([a-zA-Z0-9_-]{11})`,
            'g',
          );
          const matches = [...html.matchAll(ytRegex)];
          if (matches.length > 0) {
            const ids = Array.from(new Set(matches.map((m) => m[1])));
            tracks = ids.map((id, index) => ({
              id,
              title: `Pista ${index + 1}`,
              artist: 'Importado',
              cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            }));
          }
        }
        if (tracks.length === 0) {
          throw new Error(
            'No se pudo extraer la playlist. Usa un enlace de Spotify, YouTube, o Apple Music.',
          );
        }
      }

      if (tracks.length === 0) throw new Error('Playlist vacía o formato no soportado.');
      
      const newPlaylist: Playlist = {
        id: Date.now().toString(),
        title: playlistTitle,
        cover: tracks[0].cover,
        tracks: tracks
      };

      const updatedPlaylists = [newPlaylist, ...savedPlaylists];
      localStorage.setItem('saved-playlists', JSON.stringify(updatedPlaylists));
      setSavedPlaylists(updatedPlaylists);

      setShowPlaylistModal(false);
      setPlaylistUrl('');
      setActiveView('playlists');
      showToast('Playlist importada exitosamente');
    } catch (e: any) {
      console.error(e);
      showToast(e?.message || 'Error al importar playlist.');
    } finally {
      setIsImporting(false);
    }
  };

  const deletePlaylist = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    
    const updated = savedPlaylists.filter(p => p.id !== id);
    localStorage.setItem('saved-playlists', JSON.stringify(updated));
    setSavedPlaylists(updated);
    showToast('Playlist eliminada');
  };

  const extractVideoId = (url: string) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|\?v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  };

  const executeSearch = async (query: string) => {
    if (!query.trim()) return;
    setSearchQuery(query);

    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    if (isUrl) {
      setIsLoading(true);
      try {
        let trackId = "";
        let title = "Enlace Externo";
        if (query.includes('youtube.com') || query.includes('youtu.be')) {
           trackId = extractVideoId(query) || "";
           title = "Vídeo de YouTube";
        } else if (query.includes('vimeo.com')) {
           trackId = query.split('/').pop() || "";
           title = "Vídeo de Vimeo";
        } else if (query.match(/\.(mp3|m4a|wav|ogg|aac)$/i)) {
           playTrack({ id: `direct:${query}`, title: query.split('/').pop() || "Audio", artist: "Web", cover: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80" }, true);
           setIsLoading(false);
           return;
        }
        if (trackId) {
          playTrack({ id: trackId, title, artist: "Link", cover: `https://${atob('aW1nLnlvdXR1YmUuY29t')}/vi/${trackId}/maxresdefault.jpg` }, true);
          setIsLoading(false);
          return;
        }
      } catch (e) {}
      setIsLoading(false);
    }

    setIsLoading(true);
    setSearchPage(1);
    setAllSearchResults([]);
    setHasMoreSearch(true);
    try {
      const found = await searchYouTube(query.trim(), 50, 1, 'songs');
      const mapped = found.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        cover: t.cover,
        source: t.source,
        videoId: t.videoId,
        youtubeUrl: t.youtubeUrl,
        duration: t.duration,
      }));
      setSearchResults(mapped);
      setAllSearchResults(mapped);
      setHasMoreSearch(mapped.length >= 50);
    } catch {
      setSearchResults([]);
      setAllSearchResults([]);
      setHasMoreSearch(false);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMoreSearch = async () => {
    if (isSearchingMore || !hasMoreSearch || !searchQuery.trim()) return;
    setIsSearchingMore(true);
    const nextPage = searchPage + 1;
    try {
      const found = await searchYouTube(searchQuery.trim(), 50, nextPage, 'songs');
      const mapped = found.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        cover: t.cover,
        source: t.source,
        videoId: t.videoId,
        youtubeUrl: t.youtubeUrl,
        duration: t.duration,
      }));
      setSearchPage(nextPage);
      const dedupe = (list: Track[]) => {
        const seen = new Set<string>();
        return list.filter(t => {
          const key = `${t.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      setAllSearchResults(prev => dedupe([...prev, ...mapped]));
      setSearchResults(prev => dedupe([...prev, ...mapped]));
      setHasMoreSearch(mapped.length >= 50);
    } catch {
      setHasMoreSearch(false);
    } finally {
      setIsSearchingMore(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchQuery.trim()) {
        executeSearch(searchQuery);
      } else {
        setSearchResults([]);
        setAllSearchResults([]);
        setHasMoreSearch(false);
      }
    }, 350);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  useEffect(() => {
    if (!searchSentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreSearch && !isSearchingMore && searchQuery.trim()) {
          loadMoreSearch();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(searchSentinelRef.current);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreSearch, isSearchingMore, searchQuery]);

  const playTrack = async (
    track: Track,
    saveHistory: boolean = false,
    queueContext: Track[] = [],
    autoShowPlayer: boolean = true,
    queueMode: 'playlist' | 'radio' = 'radio',
    options?: { preloaded?: { url: string; thumbnail?: string }; fastSwitch?: boolean },
  ) => {
    const generation = ++playGenerationRef.current;
    cancelSecondaryTasks();
    const usePlaylistQueue =
      queueMode === 'playlist' &&
      queueContext.length > 1;
    const mode = usePlaylistQueue ? 'playlist' : 'radio';

    const queuedHit =
      mode === 'radio' ? consumeRadioQueueHeadIfMatch(track) : null;
    const preloaded =
      options?.preloaded ||
      (queuedHit ? { url: queuedHit.url, thumbnail: queuedHit.thumbnail } : undefined);
    const fastSwitch = !!preloaded?.url && (options?.fastSwitch === true || !!queuedHit);

    if (!fastSwitch && !preloaded) {
      const inQueue = radioQueueRef.current.some((q) => q.track.id === track.id);
      if (!inQueue) {
        radioQueueRef.current = [];
        radioQueuedIdsRef.current.clear();
        prefetchedRadioRef.current = null;
        clearNativeRadioPrefetch();
      }
    }

    if (mode === 'playlist') {
      if (hasNextInQueue()) {
        radioQueueRef.current = [];
        radioQueuedIdsRef.current.clear();
        prefetchedRadioRef.current = null;
        clearNativeRadioPrefetch();
      }
    }
    syncQueueForTrack(track, queueContext, isShuffleRef.current, mode);
    nativeEndedHandledRef.current = false;
    playedInSessionRef.current.add(track.id);
    if (mode === 'radio') {
      rememberRadioArtist(track);
    } else if (mode === 'playlist') {
      void pushPlaylistQueueToNative(playbackQueueRef.current, queueIndexRef.current);
    }

    let playingTrack = { ...track };
    setCurrentTrack(playingTrack);
    
    if (autoShowPlayer) {
      setShowPlayer(true);
    }
    
    if (!fastSwitch) {
      setIsLoading(true);
    }
    usingNativePlayerRef.current = false;

    await stopCurrentPlaybackNow();
    if (generation !== playGenerationRef.current) return;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current.loop = (repeatModeRef.current === 'one');
    } else {
      const newAudio = new Audio();
      newAudio.loop = (repeatModeRef.current === 'one');
      newAudio.addEventListener('ended', () => {
        setTrackEndedFlag(prev => prev + 1);
      });
      newAudio.addEventListener('timeupdate', () => {
        if (newAudio && isFinite(newAudio.duration) && newAudio.duration > 0 && isFinite(newAudio.currentTime)) {
          const cur = newAudio.currentTime * 1000;
          const dur = newAudio.duration * 1000;
          setCurrentTime(cur);
          setDuration(dur);
          setProgress((cur / dur) * 100);
        }
      });
      audioRef.current = newAudio;
    }
    const audio = audioRef.current;

    try {
      if (playingTrack.id.startsWith('direct:')) {
        const directUrl = playingTrack.id.replace('direct:', '');
        audio.src = directUrl;
        await audio.play();
        setIsPlaying(true);
      } 
      else {
        let audioUrl: string;
        let streamMeta: { thumbnail?: string } = {};
        if (preloaded?.url) {
          audioUrl = preloaded.url;
          streamMeta = { thumbnail: preloaded.thumbnail };
        } else {
          const cachedRadio =
            mode === 'radio' &&
            prefetchedRadioRef.current?.track.id === playingTrack.id
              ? prefetchedRadioRef.current
              : null;
          if (cachedRadio) {
            audioUrl = cachedRadio.url;
            streamMeta = { thumbnail: cachedRadio.thumbnail };
            consumeRadioQueueHeadIfMatch(playingTrack);
            syncRadioQueueMirror();
          } else {
            const stream = await resolveStreamUrl(playingTrack);
            audioUrl = stream.url;
            streamMeta = { thumbnail: stream.thumbnail };
          }
        }

        if (generation !== playGenerationRef.current || audioRef.current !== audio) {
           console.log('[Player] ⏭ Petición abortada: se solicitó una nueva canción.');
           return;
        }

        console.log('[Player] ✅ URL obtenida:', audioUrl.substring(0, 80) + '...');
        
        // 8. Validación básica de URL de stream
        if (!audioUrl || audioUrl.startsWith('blob:') || audioUrl.length < 10) {
          console.error("[Player] ❌ URL inválida devuelta por el backend:", audioUrl);
          throw new Error("Stream inválido: URL vacía o no reproducible");
        }
        
        try {
          // Android uses the native NewPipe + ExoPlayer path; desktop/web falls back to HTML audio below.
          await invoke('plugin:player|playAudio', {
            url: isAndroidRuntime()
              ? (playingTrack.youtubeUrl || (playingTrack.videoId ? `https://www.youtube.com/watch?v=${playingTrack.videoId}` : audioUrl))
              : audioUrl,
            title: playingTrack.title,
            artist: playingTrack.artist,
            thumbnail: streamMeta.thumbnail || playingTrack.cover || "",
            duration: playingTrack.duration || 0,
          });
          usingNativePlayerRef.current = true;
          audio.pause();
          audio.removeAttribute('src');
          setIsPlaying(true);
          console.log('[Player] ▶ Reproduciendo nativamente (ExoPlayer):', playingTrack.title);
          
          // --- SINCRONIZACIÓN CON ANDROID NATIVO ---
          if ((window as any).MediaEngine) {
            (window as any).MediaEngine.startBackgroundService();
            (window as any).MediaEngine.updateMetadata(playingTrack.title, playingTrack.artist, playingTrack.cover);
            (window as any).MediaEngine.updatePlaybackState(true);
          }
        } catch (nativeErr: any) {
          console.warn('[Player] ⚠️ Falló ExoPlayer o no disponible. Fallback a HTML5 Audio.', nativeErr);
          usingNativePlayerRef.current = false;

          // Fallback para PC / Web
          audio.removeAttribute('crossorigin');
          audio.preload = 'auto';
          audio.src = audioUrl;

          audio.onerror = async (e) => {
            const err = (audio as HTMLAudioElement).error;
            const code = err?.code ?? 0;
            // 10. Manejo de errores (403 o expiración) y Retry automático
            if (code === 4 || code === 2) {
                console.log("[Player] 🔄 URL posiblemente expirada o 403. Reintentando...");
                try {
                    invalidateStreamCache(playingTrack);
                    const retryStream = await resolveStreamUrl(playingTrack);
                    const retryUrl = retryStream.url;
                    if (retryUrl && !retryUrl.startsWith('blob:')) {
                        audio.onerror = null;
                        audio.src = retryUrl;
                        audio.load();
                        await audio.play();
                    }
                } catch(retryErr) {
                    console.error("[Player] ❌ Falló el reintento:", retryErr);
                }
            }
            console.error(`[Player] ❌ MediaError ${code}:`, err?.message, 'src:', audioUrl.substring(0, 120));
          };

          audio.load();

          try {
            await audio.play();
            setIsPlaying(true);
            console.log('[Player] ▶ Reproduciendo HTML5:', playingTrack.title);
          } catch (playErr: any) {
            if (playErr.name === 'AbortError') {
              console.log('[Player] ⏭ Reproducción abortada por cambio de pista.');
            } else {
              throw new Error(`Error reproduciendo HTML5: ${playErr?.message}`);
            }
          }
        }
      }

      setIsPlaying(true);
      setIsLoading(false);
      
      // MediaSession (Notificación del sistema PC/Navegador)
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: playingTrack.title,
          artist: playingTrack.artist,
          artwork: [{ src: playingTrack.cover, sizes: '512x512', type: 'image/jpeg' }]
        });
        navigator.mediaSession.setActionHandler('play', () => togglePlay());
        navigator.mediaSession.setActionHandler('pause', () => togglePlay());
        navigator.mediaSession.setActionHandler('nexttrack', () => handleNextTrack());
        navigator.mediaSession.setActionHandler('previoustrack', () => handlePreviousTrack());
      }

      if (saveHistory) {
        const history: Track[] = JSON.parse(localStorage.getItem('play-history') || '[]');
        const updated = [playingTrack, ...history.filter(t => t.id !== playingTrack.id)].slice(0, 50);
        localStorage.setItem('play-history', JSON.stringify(updated));
        setRecentTracks(updated);
      }

      if (mode === 'playlist') {
        const queue = playbackQueueRef.current;
        const idx = queueIndexRef.current;
        let nextToPrefetch: Track | null = null;
        if (shuffleOrderRef.current && queue.length > 1) {
          const nextPos = shufflePosRef.current + 1;
          if (nextPos < shuffleOrderRef.current.length) {
            nextToPrefetch = queue[shuffleOrderRef.current[nextPos]] ?? null;
          }
        } else if (idx + 1 < queue.length) {
          nextToPrefetch = queue[idx + 1];
        }
        if (nextToPrefetch) {
          prefetchStream(nextToPrefetch);
        } else {
          fillRadioQueue(playingTrack, true);
        }
      } else {
        fillRadioQueue(playingTrack, true);
      }
    } catch (e: any) {
      console.error('[Player] ❌ Error catastrófico:', e);
      const msg = typeof e === 'string' ? e : (e?.message || JSON.stringify(e) || 'Error desconocido');
      showToast(`Error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  };

  const hasNextInQueue = (): boolean => {
    const queue = playbackQueueRef.current;
    if (!currentTrack || queue.length === 0) return false;
    if (repeatModeRef.current === 'one' || repeatModeRef.current === 'all') return true;

    if (shuffleOrderRef.current && queue.length > 1) {
      const pos = shufflePosRef.current + 1;
      return pos < shuffleOrderRef.current.length;
    }

    const nextIdx = queueIndexRef.current + 1;
    return nextIdx < queue.length;
  };

  const resolveNextInQueue = (): Track | null => {
    const queue = playbackQueueRef.current;
    if (!currentTrack || queue.length === 0) return null;

    if (repeatModeRef.current === 'one') {
      return currentTrack;
    }

    if (shuffleOrderRef.current && queue.length > 1) {
      let pos = shufflePosRef.current + 1;
      if (pos >= shuffleOrderRef.current.length) {
        if (repeatModeRef.current === 'all') {
          pos = 0;
        } else {
          return null;
        }
      }
      shufflePosRef.current = pos;
      const idx = shuffleOrderRef.current[pos];
      queueIndexRef.current = idx;
      return queue[idx] ?? null;
    }

    let nextIdx = queueIndexRef.current + 1;
    if (nextIdx >= queue.length) {
      if (repeatModeRef.current === 'all') {
        nextIdx = 0;
      } else {
        return null;
      }
    }
    queueIndexRef.current = nextIdx;
    return queue[nextIdx] ?? null;
  };

  const resolvePreviousInQueue = (): Track | null => {
    const queue = playbackQueueRef.current;
    if (!currentTrack || queue.length <= 1) return null;

    if (shuffleOrderRef.current) {
      let pos = shufflePosRef.current - 1;
      if (pos < 0) {
        if (repeatModeRef.current === 'all') {
          pos = shuffleOrderRef.current.length - 1;
        } else {
          return null;
        }
      }
      shufflePosRef.current = pos;
      const idx = shuffleOrderRef.current[pos];
      queueIndexRef.current = idx;
      return queue[idx] ?? null;
    }

    let prevIdx = queueIndexRef.current - 1;
    if (prevIdx < 0) {
      if (repeatModeRef.current === 'all') {
        prevIdx = queue.length - 1;
      } else {
        return null;
      }
    }
    queueIndexRef.current = prevIdx;
    return queue[prevIdx] ?? null;
  };

  const handleNextTrack = async () => {
    if (!currentTrack || advancingRef.current) return;
    advancingRef.current = true;
    try {
      userPausedRef.current = false;

      if (repeatModeRef.current === 'one') {
        await playTrack(
          currentTrack,
          true,
          playbackQueueRef.current,
          false,
          queueModeRef.current,
        );
        return;
      }

      const usePlaylistQueue =
        queueModeRef.current === 'playlist';

      if (usePlaylistQueue) {
        const queue = playbackQueueRef.current;
        const nextInQueue = resolveNextInQueue();
        if (nextInQueue) {
          await playTrack(nextInQueue, true, queue, false, 'playlist');
          return;
        }
      }

      if (radioQueueRef.current.length > 0) {
        const next = radioQueueRef.current[0];
        await playTrack(next.track, true, [], false, 'radio', {
          preloaded: { url: next.url, thumbnail: next.thumbnail },
          fastSwitch: true,
        });
        fillRadioQueue(next.track, true);
        return;
      }

      if (prefetchedRadioRef.current) {
        const next = prefetchedRadioRef.current;
        await playTrack(next.track, true, [], false, 'radio', {
          preloaded: { url: next.url, thumbnail: next.thumbnail },
          fastSwitch: true,
        });
        fillRadioQueue(next.track, true);
        return;
      }

      const similar = await fetchSimilarTrack(currentTrack, buildRadioExcludeIds());
      if (!similar) {
        showToast('No se encontró otra canción del mismo estilo');
        return;
      }
      await playTrack(similar, true, [], false, 'radio');
    } catch (e) {
      console.error('Error al avanzar pista', e);
    } finally {
      advancingRef.current = false;
    }
  };

  const handlePreviousTrack = async () => {
    if (!currentTrack) return;
    const restartMs = 3000;
    if (currentTime > restartMs) {
      userPausedRef.current = false;
      if (usingNativePlayerRef.current) {
        try {
          await invoke('plugin:player|seekPlayback', { positionMs: 0 });
        } catch { /* ignore */ }
      } else if (audioRef.current) {
        audioRef.current.currentTime = 0;
      }
      setCurrentTime(0);
      setProgress(0);
      return;
    }

    const prev = resolvePreviousInQueue();
    if (!prev) return;
    userPausedRef.current = false;
    await playTrack(prev, false, playbackQueueRef.current, false, queueModeRef.current);
  };

  const toggleShuffle = () => {
    setIsShuffle((prev) => {
      const next = !prev;
      if (next && playbackQueueRef.current.length > 1) {
        shuffleOrderRef.current = buildShuffleOrder(
          playbackQueueRef.current.length,
          queueIndexRef.current,
        );
        shufflePosRef.current = 0;
      } else {
        shuffleOrderRef.current = null;
        shufflePosRef.current = 0;
      }
      if (queueModeRef.current === 'playlist') {
        void pushPlaylistQueueToNative(playbackQueueRef.current, queueIndexRef.current);
      }
      return next;
    });
  };

  const cycleRepeatMode = () => {
    setRepeatMode((m) => (m === 'off' ? 'all' : m === 'all' ? 'one' : 'off'));
  };

  useEffect(() => {
    if (trackEndedFlag === 0 || !currentTrack) return;
    handleNextTrack();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackEndedFlag]);

  const formatTime = (ms: number) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const formatTrackDuration = (duration?: number) => {
    if (!duration || duration <= 0) return '';
    const totalSeconds = duration > 10_000 ? Math.floor(duration / 1000) : Math.floor(duration);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleSeek = async (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    
    if (usingNativePlayerRef.current && duration > 0) {
      try {
        await invoke('plugin:player|seekPlayback', {
          positionMs: Math.floor(pct * duration),
        });
        setProgress(pct * 100);
        setCurrentTime(Math.floor(pct * duration));
      } catch { /* ignore */ }
      return;
    }
    if ((window as any).MediaEngine && (window as any).MediaEngine.seekTo) {
        const dur = (window as any).MediaEngine.getDuration();
        if (isFinite(dur) && dur > 0) {
            (window as any).MediaEngine.seekTo(Math.floor(pct * dur));
        }
    } else if (audioRef.current && isFinite(audioRef.current.duration)) {
        const newTime = pct * audioRef.current.duration;
        if (audioRef.current && isFinite(newTime)) {
            audioRef.current.currentTime = newTime;
        }
    }
    if (isFinite(pct)) setProgress(pct * 100);
  };

  const togglePlay = async () => {
    if (usingNativePlayerRef.current) {
      try {
        if (isPlaying) {
          userPausedRef.current = true;
          await invoke('plugin:player|pausePlayback');
          setIsPlaying(false);
        } else {
          userPausedRef.current = false;
          await invoke('plugin:player|resumePlayback');
          setIsPlaying(true);
        }
      } catch { /* ignore */ }
      return;
    }
    if (isPlaying) {
      userPausedRef.current = true;
      setIsPlaying(false);
      if (audioRef.current) audioRef.current.pause();
      if ((window as any).MediaEngine) {
         (window as any).MediaEngine.updatePlaybackState(false);
      }
    } else {
      userPausedRef.current = false;
      setIsPlaying(true);
      if (audioRef.current) audioRef.current.play();
      if ((window as any).MediaEngine) {
         (window as any).MediaEngine.updatePlaybackState(true);
      }
    }
  };

  // --- MEDIA SESSION API PARA NOTIFICACIÓN NATIVA ---
  const handleNextTrackRef = useRef(handleNextTrack);
  const handlePreviousTrackRef = useRef(handlePreviousTrack);
  const togglePlayRef = useRef(togglePlay);

  useEffect(() => {
    handleNextTrackRef.current = handleNextTrack;
    handlePreviousTrackRef.current = handlePreviousTrack;
    togglePlayRef.current = togglePlay;
  });

  // Puente Android nativo (notificación / segundo plano)
  const lastEndedTimeRef = useRef(0);
  useEffect(() => {
    const onNativeEnded = () => {
      const now = Date.now();
      if (now - lastEndedTimeRef.current < 1000) return; // Debounce 1 segundo
      lastEndedTimeRef.current = now;
      
      userPausedRef.current = false;
      nativeEndedHandledRef.current = true;
      setTrackEndedFlag((prev) => prev + 1);
    };
    const onEndedEvent = () => onNativeEnded();
    window.addEventListener('msic-playback-ended', onEndedEvent);

    const onNativeTrackChanged = () => {
      userPausedRef.current = false;
      nativeEndedHandledRef.current = false;
      void syncFromNativePlayback();
    };

    (window as any).MediaEventBridge = {
      play: () => togglePlayRef.current(),
      pause: () => togglePlayRef.current(),
      next: () => handleNextTrackRef.current(),
      previous: () => handlePreviousTrackRef.current(),
      onEnded: onNativeEnded,
      onTrackChanged: onNativeTrackChanged,
    };

    const onVisible = () => {
      if (!document.hidden) {
        void syncFromNativePlayback();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.removeEventListener('msic-playback-ended', onEndedEvent);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist,
        artwork: [
          { src: currentTrack.cover, sizes: '512x512', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => togglePlayRef.current());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayRef.current());
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNextTrackRef.current());
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePreviousTrackRef.current());
    }
  }, [currentTrack]);

  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }, [isPlaying]);

  const renderSearchTrackList = (
    tracks: Track[],
    saveHistory: boolean = false,
  ) => (
    <ul className={s.searchResultsList}>
      {tracks.map((song, idx) => {
        const isActive = currentTrack?.id === song.id;
        const dur = formatTrackDuration(song.duration);
        const isBrowsableResult =
          song.source === 'artist' ||
          song.source === 'album' ||
          (!song.duration && !song.videoId && !song.youtubeUrl);
        return (
          <li key={`${song.id}-${idx}`}>
            <button
              type="button"
              className={`${s.searchResultRow} ${isActive ? s.searchResultRowActive : ''}`}
              onClick={() => {
                if (isBrowsableResult) {
                  setSearchQuery(song.source === 'album' ? `${song.artist} ${song.title}` : song.title);
                  return;
                }
                playTrack(song, saveHistory, [], true, 'radio');
              }}
            >
              <div className={s.searchResultThumb}>
                <img
                  src={song.cover}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    if (song.videoId) {
                      target.src = ytThumbnail(song.videoId);
                    }
                  }}
                />
                <span className={s.searchResultPlayIcon}>
                  {isActive && isPlaying ? (
                    <Pause size={14} fill="white" />
                  ) : isBrowsableResult ? (
                    <Search size={14} color="white" />
                  ) : (
                    <Play size={14} fill="white" />
                  )}
                </span>
              </div>
              <div className={s.searchResultMeta}>
                <span className={s.searchResultTitle}>{song.title}</span>
                <span className={s.searchResultArtist}>{song.artist}</span>
              </div>
              {dur ? <span className={s.searchResultDuration}>{dur}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );

  const renderTrackList = (
    tracks: Track[],
    saveHistory: boolean = false,
    useAsQueue: boolean = false,
    queueTracks?: Track[],
  ) => (
    <div className={s.trackGrid}>
      {tracks.map((song, idx) => (
        <div key={`${song.id}-${idx}`} className={s.gridItem} onClick={() => playTrack(
          song,
          saveHistory,
          useAsQueue ? (queueTracks ?? tracks) : [],
          true,
          useAsQueue ? 'playlist' : 'radio',
        )}>
          <div className={s.imgContainer}>
            <img 
              src={song.cover} 
              alt="" 
              onError={(e) => { 
                const target = e.target as HTMLImageElement;
                if (!song.id.includes(':') && song.id.length === 11) {
                  target.src = `https://${atob('aW1nLnlvdXR1YmUuY29t')}/vi/${song.id}/hqdefault.jpg`; 
                } else {
                  target.src = "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80";
                }
              }} 
            />
            {currentTrack?.id === song.id && (
              <div className={s.playOverlay}>
                {isPlaying ? <Pause size={16} fill="white" /> : <Play size={16} fill="white" />}
              </div>
            )}
          </div>
          <h4>{song.title}</h4>
          <p>{song.artist}</p>
        </div>
      ))}
    </div>
  );

  /* ── Empty grid for bookmarks-style view ── */
  const renderEmptyGrid = () => (
    <div className={s.emptyGridWrap}>
      <div className={s.emptyGrid}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className={s.emptyCell} />
        ))}
      </div>
    </div>
  );

  return (
    <main className={s.shell}>
      <div className={s.scrollContent} style={{ paddingBottom: '100px' }}>
        <AnimatePresence mode="wait">
          {/* ─── HOME VIEW ─── */}
          {activeView === 'home' && (
            <motion.div key="home" className={`${s.viewContainer} ${s.homeView}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <section className={s.homeSection}>
                  <div className={s.sectionHeader}>
                    <h2 className={s.sectionTitle}>Recomendado para ti</h2>
                  </div>
                  <div className={s.horizontalScroll}>
                    {isFetchingRecs ? (
                      [1, 2, 3, 4, 5].map((i) => <motion.div key={i} className={s.skeletonTrend} />)
                    ) : homeRecommendations.length > 0 ? (
                      homeRecommendations.map((track) => (
                        <motion.div 
                          key={track.id} 
                          className={s.trendCard}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => playTrack(track, true, [], true, 'radio')}
                        >
                          <div className={s.trendCoverWrap}>
                            <img src={track.cover} alt={track.title} className={s.trendCover} />
                            <div className={s.trendPlayOverlay}>
                              <Play size={16} fill="white" />
                            </div>
                          </div>
                          <motion.div className={s.trendInfo}>
                            <p className={s.trendTitle}>{track.title}</p>
                            <p className={s.trendArtist}>{track.artist}</p>
                          </motion.div>
                        </motion.div>
                      ))
                    ) : (
                      <p className={s.emptyText} style={{ padding: '12px 4px', minWidth: '160px', fontSize: '0.8rem' }}>
                        {recentTracks.length > 0 ? 'Escucha más para mejorar tus recomendaciones.' : 'Busca música para empezar.'}
                      </p>
                    )}
                  </div>
                </section>

              {recentTracks.length > 0 && (
                <section className={s.homeSection}>
                  <div className={s.sectionHeader}>
                    <h2 className={s.sectionTitle}>Volver a escuchar</h2>
                  </div>
                  <div className={s.horizontalScroll}>
                    {recentTracks.map((track) => (
                      <motion.div
                        key={track.id}
                        className={s.trendCard}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => playTrack(track, true, [], true, 'radio')}
                      >
                        <div className={s.trendCoverWrap}>
                          <img src={track.cover} alt={track.title} className={s.trendCover} />
                          <div className={s.trendPlayOverlay}>
                            <Play size={16} fill="white" />
                          </div>
                        </div>
                        <div className={s.trendInfo}>
                          <p className={s.trendTitle}>{track.title}</p>
                          <p className={s.trendArtist}>{track.artist}</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </section>
              )}

                {savedPlaylists.length > 0 && (
                  <section className={s.homeSection}>
                    <div className={s.sectionHeader}>
                      <h2 className={s.sectionTitle}>Tus listas</h2>
                    </div>
                    <div className={s.horizontalScroll}>
                      {savedPlaylists.map((playlist) => (
                        <motion.div
                          key={playlist.id}
                          className={s.trendCard}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => {
                            setActivePlaylist(playlist);
                            setActiveView('playlist-details');
                          }}
                        >
                          <div className={s.trendCoverWrap}>
                            <img src={playlist.cover} alt="" className={s.trendCover} />
                          </div>
                          <div className={s.trendInfo}>
                            <p className={s.trendTitle}>{playlist.title}</p>
                            <p className={s.trendArtist}>{playlist.tracks.length} canciones</p>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </section>
                )}

              {recentTracks.length === 0 && homeRecommendations.length === 0 && !isFetchingRecs && (
                <div className={s.centerMessage}>
                  <Headphones size={28} color="white" />
                  <h2>Empieza a escuchar</h2>
                  <p>Busca en YouTube o importa una playlist para comenzar.</p>
                </div>
              )}
            </motion.div>
          )}

          {/* ─── SEARCH / BOOKMARKS VIEW ─── */}
          {activeView === 'search' && (
            <motion.div key="search" className={s.viewContainer} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

              <div style={{ height: 'calc(72px + var(--safe-area-inset-top, 0px))', marginBottom: '8px' }} />

              <div className={s.contentArea}>
                {isLoading && searchResults.length === 0 ? (
                  <div className={s.centerLoader}><Loader2 size={24} className="spin" color="#fff" /></div>
                ) : searchQuery && allSearchResults.length === 0 && !isLoading ? (
                   <p className={s.emptyText}>Sin resultados para «{searchQuery}».</p>
                ) : searchQuery ? (
                  <>
                    <p className={s.searchResultsMeta}>
                      {allSearchResults.length} resultado{allSearchResults.length === 1 ? '' : 's'}
                    </p>
                    {renderSearchTrackList(allSearchResults, true)}
                    {hasMoreSearch && (
                      <div ref={searchSentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
                        {isSearchingMore ? (
                          <Loader2 size={20} className="spin" color="rgba(255,255,255,0.5)" />
                        ) : (
                          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.85rem' }}>Desliza para más resultados</span>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {recentTracks.length > 0 ? (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                          <h3 className={s.subTitle} style={{ margin: 0 }}>Recientes</h3>
                          <button 
                            onClick={() => {
                              localStorage.removeItem('play-history');
                              setRecentTracks([]);
                            }}
                            style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '0.85rem' }}
                          >
                            Limpiar
                          </button>
                        </div>
                        {renderTrackList(recentTracks, true, true)}
                      </>
                    ) : (
                      renderEmptyGrid()
                    )}
                  </>
                )}
              </div>
            </motion.div>
          )}

          {/* ─── PLAYLISTS VIEW ─── */}
          {activeView === 'playlists' && (
            <motion.div key="playlists" className={s.viewContainer} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className={s.headerFlex}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button className={s.iconCircle} onClick={() => setActiveView('home')}>
                    <ArrowLeft size={20} color="#fff" />
                  </button>
                  <h1 className={s.pageTitle}>Tus Playlist</h1>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className={s.iconCircle} onClick={() => setShowCreatePlaylistModal(true)} aria-label="Crear playlist">
                    <PlusCircle size={20} color="#fff" />
                  </button>
                  <button className={s.iconCircle} onClick={() => setShowPlaylistModal(true)} aria-label="Importar playlist">
                    <Plus size={20} color="#fff" />
                  </button>
                </div>
              </div>

              <div className={s.contentArea}>
                {savedPlaylists.length > 0 ? (
                  <div className={s.trackGrid}>
                    {savedPlaylists.map(playlist => (
                      <div key={playlist.id} className={s.gridItem} onClick={() => {
                        setActivePlaylist(playlist);
                        setActiveView('playlist-details');
                      }}>
                        <div className={s.imgContainer}>
                          <img src={playlist.cover} alt="" />
                          <button 
                            className={s.deleteBtn} 
                            onClick={(e) => deletePlaylist(playlist.id, e)}
                            title="Borrar Playlist"
                          >
                            <Trash2 size={16} color="white" />
                          </button>
                        </div>
                        <h4>{playlist.title}</h4>
                        <p>{playlist.tracks.length} canciones</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={s.emptyText}>No has guardado ninguna playlist.</p>
                )}
              </div>
            </motion.div>
          )}

          {/* ─── PLAYLIST DETAILS VIEW ─── */}
          {activeView === 'playlist-details' && activePlaylist && (
            <motion.div key="playlist-details" className={s.viewContainer} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className={s.headerFlex} style={{ gap: '12px', justifyContent: 'flex-start' }}>
                <button className={s.iconCircle} onClick={() => setActiveView('playlists')}>
                  <ArrowLeft size={20} color="#fff" />
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                   <img src={activePlaylist.cover} alt="" style={{ width: '40px', height: '40px', borderRadius: '8px', objectFit: 'cover' }} />
                   <h1 className={s.pageTitle} style={{ fontSize: '1.4rem' }}>{activePlaylist.title}</h1>
                </div>
              </div>

              <div className={s.contentArea}>
                {renderTrackList(
                  // Need to find the up-to-date playlist from state so background covers show up
                  savedPlaylists.find(p => p.id === activePlaylist.id)?.tracks || activePlaylist.tracks,
                  false,
                  true // Pasar true para que las playlists sí se reproduzcan de forma continua
                )}
              </div>
            </motion.div>
          )}

          {/* ─── SETTINGS VIEW ─── */}
          {activeView === 'settings' && (
            <motion.div key="settings" className={s.viewContainer} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className={s.headerFlex}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button className={s.iconCircle} onClick={() => setActiveView('home')}>
                    <ArrowLeft size={20} color="#fff" />
                  </button>
                  <h1 className={s.pageTitle}>Ajustes</h1>
                </div>
              </div>

              <div className={s.contentArea}>
                <div className={s.settingsCard}>
                  <p style={{ fontSize: '0.9rem', color: '#aaa', marginBottom: '20px', lineHeight: '1.5' }}>
                    La música se reproduce desde YouTube. No necesitas configurar ningún proveedor adicional.
                  </p>

                  <div className={s.dangerZone}>
                    <h3 className={s.dangerTitle}>Zona de Peligro</h3>
                    <p className={s.dangerDesc}>
                      Si la aplicación presenta errores o quieres borrar todos tus datos (playlists, historial y ajustes), usa esta opción.
                    </p>
                    <button 
                      className={`${s.pillButton} ${s.dangerButton}`} 
                      onClick={resetApp}
                    >
                      <Trash2 size={18} />
                      Restablecer Todo
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}


        </AnimatePresence>
      </div>

      {/* ─── BOTTOM NAV: solo los botones circulares ─── */}
      <nav className={s.bottomNav}>
        <AnimatePresence>
          {activeView !== 'search' && (
            <>
              <motion.button 
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.2 }}
                className={`${s.iconCircle} ${activeView === 'settings' ? s.activeGlass : ''}`} 
                aria-label="Ajustes" 
                onClick={() => setActiveView('settings')}
              >
                <Settings size={18} color={activeView === 'settings' ? "#fff" : "#888"} />
              </motion.button>
              
              <motion.button 
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.2 }}
                className={`${s.iconCircle} ${activeView === 'playlists' || activeView === 'playlist-details' ? s.activeGlass : ''}`} 
                aria-label="Playlists" 
                onClick={() => setActiveView('playlists')}
              >
                <ListMusic size={18} color={activeView === 'playlists' || activeView === 'playlist-details' ? "#fff" : "#888"} />
              </motion.button>


            </>
          )}
        </AnimatePresence>
      </nav>

      {/* ─── FLOATING SEARCH BAR (vuela de abajo hacia arriba) ─── */}
      <motion.div
        className={activeView === 'search' ? s.searchBarPill : s.inputPill}
        onClick={() => { if (activeView !== 'search') setActiveView('search'); }}
        initial={false}
        animate={{
          top: activeView === 'search' 
            ? 'calc(24px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))' 
            : 'calc(100vh - 66px - var(--safe-area-inset-bottom, 0px))',
          left: activeView === 'search' ? '72px' : '118px',
          right: activeView === 'search' ? '20px' : '12px',
        }}
        transition={{ type: 'spring', damping: 28, stiffness: 280 }}
        style={{ position: 'fixed', borderRadius: activeView === 'search' ? '20px' : '50px', zIndex: 200, cursor: 'pointer' }}
      >
        {activeView === 'search' ? (
          <>
            <Search size={18} color="#888" />
            <input
              autoFocus
              className={s.searchBarInput}
              placeholder="Canciones, artistas o álbumes"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className={s.searchClearBtn}
                onClick={(e) => { e.stopPropagation(); setSearchQuery(''); }}
                aria-label="Borrar búsqueda"
              >
                <X size={16} color="#888" />
              </button>
            )}
          </>
        ) : (
          <span>Buscar música</span>
        )}
      </motion.div>

      {/* ─── BACK BUTTON (nace al lado de la barra cuando sube) ─── */}
      <AnimatePresence>
        {activeView === 'search' && (
          <motion.button
            className={s.iconCircle}
            initial={{ opacity: 0, scale: 0, x: -10 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0, x: -10 }}
            transition={{ type: 'spring', damping: 22, stiffness: 300, delay: 0.1 }}
            onClick={() => setActiveView('home')}
            style={{ position: 'fixed', top: 'calc(24px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))', left: '20px', zIndex: 201 }}
            aria-label="Volver"
          >
            <ArrowLeft size={18} color="#fff" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ─── PLAYER OVERLAY ─── */}
      <AnimatePresence>
        {showPlayer && currentTrack && (
          <motion.div className={s.fullPlayer} initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }}>
            {/* Dynamic Glass Background */}
            <div className={s.glassBackground}>
              <img src={currentTrack.cover} alt="blur bg" />
              <div className={s.glassOverlay} />
            </div>

            <div className={s.playerHeader}>
              <button className={s.playerCloseBtn} onClick={() => setShowPlayer(false)}>
                <X size={18} color="white" />
              </button>
              <span>{showLyrics ? 'Letras' : 'Reproduciendo'}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className={s.playerCloseBtn}
                  onClick={() => setShowLyrics(v => !v)}
                  title="Letras"
                  style={{ 
                    opacity: (lyrics.length > 0 || lyricsPlain) ? 1 : 0.35,
                    background: showLyrics ? (extractedColors[0] || 'rgba(255,255,255,0.1)') : 'rgba(255,255,255,0.08)'
                  }}
                >
                  <Mic2 size={16} color="white" />
                </button>
                <button
                  className={s.playerCloseBtn}
                  onClick={openDevicePicker}
                  title="Dispositivo de salida"
                  style={{ background: 'rgba(255,255,255,0.08)' }}
                >
                  <MonitorSpeaker size={16} color="white" />
                </button>
              </div>
            </div>

            <div className={s.playerContent}>
              <div className={s.playerMain}>
              <AnimatePresence mode="wait">
                {showLyrics ? (
                  <motion.div
                    key="lyrics"
                    className={s.lyricsPanel}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.25 }}
                  >
                    {lyricsLoading ? (
                      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '60px' }}>
                        <Loader2 size={24} className="spin" color="rgba(255,255,255,0.4)" />
                      </div>
                    ) : lyrics.length > 0 ? (
                      <div className={s.lyricsWrap}>
                        <div className={s.lyricsScroll} ref={lyricsContainerRef}>
                          {currentTime + lyricsOffset < lyrics[0].time && (
                            <div className={`${s.lyricLine} ${s.lyricActive}`}>
                              <Music size={24} color="rgba(255,255,255,0.8)" />
                            </div>
                          )}
                          {lyrics.map((line, i) => {
                            const nextTime = lyrics[i + 1]?.time ?? Infinity;
                            const effectiveTime = currentTime + lyricsOffset;
                            const isActive = effectiveTime >= line.time && effectiveTime < nextTime;
                            return (
                              <div
                                key={i}
                                ref={isActive ? activeLyricRef : null}
                                className={`${s.lyricLine} ${isActive ? s.lyricActive : ''}`}
                              >
                                <div className={s.lyricOriginal}>
                                  {line.words ? (
                                    <span className={s.syllableContainer}>
                                      {line.words.map((word, wIdx) => {
                                        const isWordActive = effectiveTime >= word.time;
                                        return (
                                          <span
                                            key={wIdx}
                                            className={`${s.lyricSyllable} ${isWordActive ? s.syllableActive : ''}`}
                                          >
                                            {word.text}
                                          </span>
                                        );
                                      })}
                                    </span>
                                  ) : (
                                    line.text || '•••'
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className={s.lyricsOffsetControls}>
                          <button onClick={(e) => { e.stopPropagation(); setLyricsOffset(o => o - 500); }} title="Atrasar letra 0.5s">-0.5s</button>
                          <button onClick={(e) => { e.stopPropagation(); setLyricsOffset(0); }} title="Restablecer">
                            {lyricsOffset !== 0 ? `${lyricsOffset > 0 ? '+' : ''}${lyricsOffset / 1000}s` : 'Sincronizar'}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setLyricsOffset(o => o + 500); }} title="Adelantar letra 0.5s">+0.5s</button>
                        </div>
                      </div>
                    ) : lyricsPlain ? (
                      <div className={s.lyricsScroll}>
                        {lyricsPlain.split('\n').map((line, i) => (
                          <div key={i} className={s.lyricLine}>{line || '\u00a0'}</div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', paddingTop: '80px', color: 'rgba(255,255,255,0.3)', fontSize: '0.9rem' }}>
                        <Mic2 size={32} style={{ marginBottom: '12px', opacity: 0.3 }} />
                        <p>No hay letras disponibles</p>
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="art"
                    className={s.playerArtWrap}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.25 }}
                  >
                    <img src={currentTrack.cover} alt="" className={s.playerArt} />
                    <div id="hidden-audio-engine" style={{ position: 'absolute', pointerEvents: 'none' }}></div>
                  </motion.div>
                )}
              </AnimatePresence>
              </div>

              <div className={s.playerFooter}>
              <div className={s.playerText} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', width: '100%' }}>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <h2 style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentTrack.title}</h2>
                  <p style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentTrack.artist}</p>
                </div>
                <button 
                  className={s.controlBtn} 
                  style={{ padding: '8px', marginLeft: '12px' }} 
                  onClick={() => setShowAddToPlaylistModal(true)}
                  title="Agregar a Playlist"
                >
                  <PlusCircle size={24} color="#fff" />
                </button>
              </div>

              <div className={s.progressContainer}>
                <div className={s.progressWrap} onClick={handleSeek}>
                  <div className={s.progressBgBar}>
                    <div className={s.progressFill} style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#aaa', marginTop: '8px' }}>
                   <span>{formatTime(currentTime)}</span>
                   <span>{formatTime(duration)}</span>
                </div>
              </div>

              <div className={s.playerControls}>
                <button className={s.controlBtn} onClick={toggleShuffle} aria-label="Aleatorio">
                  <Shuffle size={20} color={isShuffle ? "#1db954" : "#888"} />
                </button>
                <button className={s.controlBtn} onClick={() => handlePreviousTrack()} aria-label="Anterior">
                  <SkipBack size={28} fill="white" />
                </button>
                <button className={s.playBtn} onClick={togglePlay}>
                  {isPlaying ? <Pause size={28} fill="black" /> : <Play size={28} fill="black" />}
                </button>
                <button className={s.controlBtn} onClick={() => handleNextTrack()} aria-label="Siguiente">
                  <SkipForward size={28} fill="white" />
                </button>
                <button className={s.controlBtn} onClick={cycleRepeatMode} aria-label="Repetir">
                  {repeatMode === 'one' ? (
                    <Repeat1 size={20} color="#1db954" />
                  ) : (
                    <Repeat size={20} color={repeatMode === 'all' ? "#1db954" : "#888"} />
                  )}
                </button>
              </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── MINI PLAYER (SPINNING VINYL) ─── */}
      <AnimatePresence>
        {!showPlayer && currentTrack && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.5, y: 20 }}
            transition={{ type: 'spring', damping: 22 }}
            className={`${s.miniPlayer} ${isMiniExpanded ? s.miniExpanded : ''}`}
          >
            <div 
              className={s.miniExpander} 
              onClick={(e) => { e.stopPropagation(); setIsMiniExpanded(!isMiniExpanded); }}
            >
              {isMiniExpanded ? <ChevronRight size={18} color="white" /> : <ChevronLeft size={18} color="white" />}
            </div>

            <div className={s.miniVinylWrap} onClick={() => setShowPlayer(true)}>
              <img 
                src={currentTrack.cover} 
                alt="Vinyl" 
                className={isPlaying ? s.spinning : ''} 
              />
              <div className={s.vinylHole} />
            </div>

            <AnimatePresence>
              {isMiniExpanded && (
                <motion.div 
                  className={s.miniContent}
                  initial={{ opacity: 0, width: 0, paddingLeft: 0 }}
                  animate={{ opacity: 1, width: 'auto', paddingLeft: 10 }}
                  exit={{ opacity: 0, width: 0, paddingLeft: 0 }}
                  style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
                >
                  <div className={s.miniText} onClick={() => setShowPlayer(true)}>
                    <h4>{currentTrack.title}</h4>
                    <p>{currentTrack.artist}</p>
                  </div>
                  <div className={s.miniControls}>
                    <button onClick={(e) => { e.stopPropagation(); togglePlay(); }}>
                      {isPlaying ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setShowPlayer(true); }}>
                      <ListMusic size={20} color="white" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── ADD TO PLAYLIST MODAL ─── */}
      <AnimatePresence>
        {showAddToPlaylistModal && currentTrack && (
          <motion.div className={s.modalOverlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowAddToPlaylistModal(false)}>
            <motion.div className={`${s.modalCard} ${s.glassModal}`} initial={{ y: 60, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 60, opacity: 0, scale: 0.95 }} transition={{ type: 'spring', damping: 25 }} onClick={(e) => e.stopPropagation()}>
              <div className={s.modalHeader}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: '600', letterSpacing: '-0.3px' }}>Guardar en lista</h3>
                <button className={s.iconCircleClose} onClick={() => setShowAddToPlaylistModal(false)}><X size={18} /></button>
              </div>
              <div className={s.modalBody} style={{ padding: '12px 0 0' }}>
                {savedPlaylists.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 20px' }}>
                    <p style={{ color: '#888', fontSize: '0.9rem', marginBottom: '16px' }}>No tienes listas guardadas.</p>
                    <button className={s.startSaving} onClick={() => { setShowAddToPlaylistModal(false); setShowPlaylistModal(true); }}>Importar Playlist</button>
                  </div>
                ) : (
                  <div className={s.playlistOptionsList}>
                    {savedPlaylists.map(playlist => (
                      <button 
                        key={playlist.id} 
                        className={s.playlistOptionBtn}
                        onClick={() => {
                          const updated = savedPlaylists.map(p => {
                            if (p.id === playlist.id) {
                              return { ...p, tracks: [...p.tracks, currentTrack] };
                            }
                            return p;
                          });
                          setSavedPlaylists(updated);
                          localStorage.setItem('saved-playlists', JSON.stringify(updated));
                          setShowAddToPlaylistModal(false);
                          showToast('Añadido a ' + playlist.title);
                        }}
                      >
                        <div className={s.playlistOptionImgWrap}>
                          <img src={playlist.cover} alt="" />
                        </div>
                        <div className={s.playlistOptionText}>
                          <span>{playlist.title}</span>
                          <small>{playlist.tracks.length} canciones</small>
                        </div>
                        <div className={s.addPlusIcon}><Plus size={16} /></div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── CREATE PLAYLIST MODAL ─── */}
      <AnimatePresence>
        {showCreatePlaylistModal && (
          <motion.div className={s.modalOverlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreatePlaylistModal(false)}>
            <motion.div className={s.modalCard} initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }} transition={{ type: 'spring', damping: 25 }} onClick={(e) => e.stopPropagation()}>
              <div className={s.modalHeader}>
                <PlusCircle size={20} color="#fff" />
                <h3>Nueva playlist</h3>
                <button className={s.playerCloseBtn} onClick={() => setShowCreatePlaylistModal(false)}>
                  <X size={16} color="#fff" />
                </button>
              </div>
              <div className={s.searchBarPill}>
                <input
                  placeholder="Nombre de la playlist"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createPlaylist()}
                />
              </div>
              <button className={`${s.pillButton} ${s.pillButtonAccent}`} onClick={createPlaylist} style={{ width: '100%', marginTop: '12px' }}>
                <Plus size={18} />
                Crear
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── PLAYLIST IMPORT MODAL ─── */}
      <AnimatePresence>
        {showPlaylistModal && (
          <motion.div className={s.modalOverlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowPlaylistModal(false)}>
            <motion.div className={s.modalCard} initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }} transition={{ type: 'spring', damping: 25 }} onClick={(e) => e.stopPropagation()}>
              <div className={s.modalHeader}>
                <ListMusic size={20} color="#fff" />
                <h3>Importar Playlist</h3>
                <button className={s.playerCloseBtn} onClick={() => setShowPlaylistModal(false)}>
                  <X size={16} color="#fff" />
                </button>
              </div>
              <p className={s.modalDesc}>Pega un enlace público de YouTube, Spotify, Apple Music u otra página con lista de canciones.</p>
              <div className={s.searchBarPill}>
                <Link2 size={18} color="#555" />
                <input
                  placeholder="Pega el enlace de tu playlist"
                  value={playlistUrl}
                  onChange={e => setPlaylistUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && importPlaylist()}
                />
              </div>
              <button className={`${s.pillButton} ${s.pillButtonAccent}`} onClick={importPlaylist} disabled={isImporting} style={{ width: '100%', marginTop: '12px' }}>
                {isImporting ? <Loader2 size={18} className="spin" /> : <Plus size={18} />}
                {isImporting ? 'Importando...' : 'Importar'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── MODAL DE GESTIÓN DE FUENTES ELIMINADO ─── */}

      {/* ─── DEVICE PICKER MODAL ─── */}
      <AnimatePresence>
        {showDevicePicker && (
          <motion.div className={s.modalOverlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowDevicePicker(false)}>
            <motion.div 
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                background: extractedColors[0] || '#1e1e24',
                padding: '24px 16px',
                borderTopLeftRadius: '24px',
                borderTopRightRadius: '24px',
                boxShadow: '0 -10px 40px rgba(0,0,0,0.5)',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                maxWidth: '600px',
                margin: '0 auto'
              }}
              initial={{ y: '100%' }} 
              animate={{ y: 0 }} 
              exit={{ y: '100%' }} 
              transition={{ type: 'spring', damping: 25, stiffness: 200 }} 
              onClick={(e) => e.stopPropagation()}
            >
              {currentTrack && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <img src={currentTrack.cover} alt="cover" style={{ width: 48, height: 48, borderRadius: '8px', objectFit: 'cover' }} />
                  <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <span style={{ fontWeight: 600, fontSize: '1rem', color: '#fff', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{currentTrack.title}</span>
                    <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{currentTrack.artist}</span>
                  </div>
                </div>
              )}
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '50vh', overflowY: 'auto' }}>
                <button style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', borderRadius: '16px', background: activeDeviceType === 'BUILT_IN_SPEAKER' || activeDeviceType === 'WIRED_HEADSET' ? 'rgba(0,200,83,0.2)' : 'rgba(255,255,255,0.1)', border: activeDeviceType === 'BUILT_IN_SPEAKER' ? '1px solid rgba(0,200,83,0.5)' : 'none', color: '#fff', width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={async () => {
                  try {
                    if (isTauriMobile()) {
                      const res = await invoke<{ switched: boolean }>('plugin:player|switchToSpeaker');
                      if (!res.switched) console.log('No BT to disconnect, audio already on speaker');
                    }
                    setShowDevicePicker(false);
                  } catch { setShowDevicePicker(false); }
                }}>
                  <Smartphone size={24} color={activeDeviceType === 'BUILT_IN_SPEAKER' ? '#00c853' : '#fff'} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 500, fontSize: '1rem' }}>Este teléfono</span>
                    <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>Altavoz / auricular</span>
                  </div>
                  {activeDeviceType === 'BUILT_IN_SPEAKER' && <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#00c853' }}>Activo</span>}
                </button>
                
                {pairedDevices.length > 0 ? (
                  pairedDevices.map((device, idx) => (
                    <button
                      key={`${device.address}-${idx}`}
                      style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', borderRadius: '16px', background: device.isActive ? 'rgba(0,200,83,0.15)' : 'rgba(255,255,255,0.05)', border: device.isActive ? '1px solid rgba(0,200,83,0.4)' : 'none', color: '#fff', width: '100%', textAlign: 'left', cursor: 'pointer' }}
                      onClick={async () => {
                        try {
                          if (isTauriMobile()) {
                            await invoke<{ connected: boolean }>('plugin:player|connectToBluetoothDevice', { address: device.address });
                          }
                          setShowDevicePicker(false);
                        } catch { setShowDevicePicker(false); }
                      }}
                    >
                      <Headphones size={24} color={device.isActive ? '#00c853' : '#fff'} />
                      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
                        <span style={{ fontWeight: 500, fontSize: '1rem', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{device.name}</span>
                        <span style={{ fontSize: '0.8rem', color: device.isActive ? 'rgba(0,200,83,0.7)' : 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{device.isActive ? 'Sonando ahora' : 'Vinculado'}</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', borderRadius: '16px', background: 'rgba(255,255,255,0.05)', border: 'none', color: '#888', width: '100%' }}>
                      <Headphones size={24} color="#555" />
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 500, fontSize: '1rem' }}>Sin dispositivos vinculados</span>
                        <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)' }}>Presiona abajo para vincular uno</span>
                      </div>
                    </div>
                  </div>
                )}

                <button style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px', borderRadius: '16px', background: 'transparent', border: '1px dashed rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.8)', width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={async () => {
                  try {
                    if (isTauriMobile()) {
                      await invoke('plugin:player|openBluetoothSettings');
                    }
                    setShowDevicePicker(false);
                  } catch {
                    setShowDevicePicker(false);
                  }
                }}>
                  <Plus size={24} />
                  <span style={{ fontWeight: 500, fontSize: '1rem' }}>Conectar un dispositivo</span>
                </button>
              </div>

              <button 
                style={{ 
                  marginTop: '8px', 
                  background: 'rgba(255,255,255,0.15)', 
                  color: '#fff', 
                  border: 'none', 
                  padding: '16px', 
                  borderRadius: '100px', 
                  fontWeight: 600, 
                  fontSize: '1rem',
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }} 
                onClick={() => setShowDevicePicker(false)}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.25)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
              >
                Hecho
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── TOAST NOTIFICATION ─── */}

      <AnimatePresence>
        {toastMessage && (
          <motion.div 
            initial={{ opacity: 0, y: 50, x: '-50%', scale: 0.9 }} 
            animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }} 
            exit={{ opacity: 0, scale: 0.9, y: 20, x: '-50%' }} 
            style={{ 
              position: 'fixed', 
              bottom: '100px', 
              left: '50%', 
              background: 'rgba(30, 30, 30, 0.75)', 
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              padding: '12px 24px', 
              borderRadius: '30px', 
              color: '#fff', 
              fontSize: '0.9rem',
              fontWeight: 500,
              zIndex: 1000,
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
              border: '1px solid rgba(255,255,255,0.08)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap'
            }}
          >
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

import { invoke } from '@tauri-apps/api/core';
import { searchYouTubeInnerTube } from './youtube-engine';

export type YouTubeSearchFilter = 'songs' | 'videos' | 'artists' | 'albums';

export interface SearchTrack {
  id: string;
  title: string;
  artist: string;
  cover: string;
  source: 'youtube' | 'artist' | 'album';
  videoId?: string;
  youtubeUrl?: string;
  duration?: number;
}

interface NativeSearchResponse {
  results: Array<{
    id?: string;
    title?: string;
    artist?: string;
    cover?: string;
    source?: string;
    videoId?: string;
    youtubeUrl?: string;
    duration?: number;
  }>;
  count: number;
}

const FALLBACK_COVER =
  'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80';

const FILTER_TOKENS: Record<YouTubeSearchFilter, string> = {
  songs: 'songs',
  videos: 'videos',
  artists: 'artists',
  albums: 'albums',
};

const normalize = (text: string) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const dedupeKey = (track: SearchTrack) =>
  `${track.source}|${normalize(track.title)}|${normalize(track.artist)}|${track.videoId || track.youtubeUrl || ''}`;

const cleanSource = (source?: string): SearchTrack['source'] => {
  if (source === 'artist' || source === 'album') return source;
  return 'youtube';
};

const mapNativeResult = (item: NativeSearchResponse['results'][number]): SearchTrack | null => {
  const title = item.title?.trim();
  if (!title) return null;

  const source = cleanSource(item.source);
  const videoId = item.videoId?.trim() || '';
  const youtubeUrl = item.youtubeUrl?.trim() || '';
  return {
    id: item.id || videoId || youtubeUrl || `${source}:${title}:${item.artist || ''}`,
    title,
    artist: item.artist?.trim() || (source === 'artist' ? 'Artista' : 'Desconocido'),
    cover: item.cover || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : FALLBACK_COVER),
    source,
    videoId: source === 'youtube' ? videoId : undefined,
    youtubeUrl: source === 'youtube' ? youtubeUrl : undefined,
    duration: source === 'youtube' ? item.duration || 0 : 0,
  };
};

const dedupe = (tracks: SearchTrack[]) => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = dedupeKey(track);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export async function searchYouTube(
  query: string,
  limit = 50,
  page = 1,
  filter: YouTubeSearchFilter = 'songs',
): Promise<SearchTrack[]> {
  const q = query.trim();
  if (!q) return [];

  const isAndroid =
    typeof window !== 'undefined' && navigator.userAgent.toLowerCase().includes('android');

  try {
    const raw = await invoke<NativeSearchResponse>('plugin:player|searchYouTube', {
      query: q,
      limit: Math.min(Math.max(limit, 1), 50),
      page: Math.max(page, 1),
      filter: FILTER_TOKENS[filter],
    });

    const mapped = dedupe((raw.results || []).map(mapNativeResult).filter(Boolean) as SearchTrack[]);
    if (mapped.length > 0 || isAndroid) return mapped.slice(0, limit);
  } catch (err) {
    console.warn('[Search] Native search unavailable:', err);
    if (isAndroid) return [];
  }

  if (filter === 'artists' || filter === 'albums') return [];

  const web = await searchYouTubeInnerTube(q, limit);
  return dedupe(
    web.map((item) => ({
      id: `yt:${item.videoId}`,
      title: item.title,
      artist: item.artist,
      cover: item.cover || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
      source: 'youtube' as const,
      videoId: item.videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
      duration: item.duration,
    })),
  );
}

export async function searchMusicCatalog(query: string): Promise<SearchTrack[]> {
  return searchYouTube(query, 50, 1, 'songs');
}

export async function getSearchSuggestions(query: string): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=chrome&ds=yt&q=${encodeURIComponent(q)}`,
    );
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    return Array.isArray(data?.[1]) ? data[1].slice(0, 8) : [];
  } catch {
    return [];
  }
}

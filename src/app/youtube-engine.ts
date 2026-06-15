'use client';

import { fetch } from '@tauri-apps/plugin-http';

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.syncstream.org',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.moomoo.me',
];

const REQUEST_TIMEOUT_MS = 4000;

async function fetchFromAnyInstance<T>(path: string): Promise<T> {
  const promises = PIPED_INSTANCES.map(async (base) => {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(id);
      if (!res.ok) {
        throw new Error(`Instance ${base} returned status ${res.status}`);
      }
      return await res.json() as T;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  });
  return Promise.any(promises);
}

export async function resolveAudioUrl(videoId: string): Promise<string | null> {
  try {
    const data = await fetchFromAnyInstance<{ audioStreams?: { url: string; bitrate?: number }[] }>(
      `/streams/${videoId}`
    );
    const streams = data.audioStreams || [];
    // Sort by bitrate descending
    streams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    for (const s of streams) {
      if (s.url && !s.url.startsWith('blob:')) {
        return s.url;
      }
    }
  } catch (err) {
    console.error('[NewPipe Extractor] Failed to resolve stream for video:', videoId, err);
  }
  return null;
}

export interface YtSearchItem {
  videoId: string;
  title: string;
  artist: string;
  cover: string;
  duration: number;
}

export async function searchYouTubeInnerTube(
  query: string,
  limit: number = 25,
): Promise<YtSearchItem[]> {
  if (!query.trim()) return [];
  try {
    const data = await fetchFromAnyInstance<{
      items?: {
        url?: string;
        type?: string;
        title?: string;
        uploaderName?: string;
        thumbnail?: string;
        duration?: number;
      }[];
    }>(`/search?q=${encodeURIComponent(query)}&filter=videos`);
    
    const items = data.items || [];
    const results: YtSearchItem[] = [];

    for (const item of items) {
      if (results.length >= limit) break;
      if (item.type === 'stream' || item.type === 'video') {
        if (item.url) {
          const videoId = item.url.split('v=')[1]?.split('&')[0];
          if (videoId) {
            results.push({
              videoId,
              title: item.title || 'Sin título',
              artist: item.uploaderName || 'Desconocido',
              cover: item.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              duration: item.duration || 0,
            });
          }
        }
      }
    }
    return results;
  } catch (err) {
    console.error('[NewPipe Search] Search failed for query:', query, err);
    return [];
  }
}

export const initYtEngine = async (): Promise<void> => {};

import { fetch } from '@tauri-apps/plugin-http';

export interface ImportedTrack {
  id: string;
  title: string;
  artist: string;
  cover: string;
}

export interface ImportedPlaylist {
  title: string;
  tracks: ImportedTrack[];
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_COVER =
  'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=500&q=80';

const YT_IMG = 'https://i.ytimg.com/vi';

/** Extrae JSON balanceado desde un índice de `{`. */
export function extractBalancedJson(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.substring(startIndex, i + 1);
    }
  }
  return null;
}

export async function fetchPageHtml(pageUrl: string): Promise<string> {
  const res = await fetch(pageUrl, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`No se pudo abrir el enlace (${res.status})`);
  return res.text();
}

function normalizePlaylistUrl(raw: string): string {
  let url = raw.trim();
  if (!url.startsWith('http')) url = `https://${url}`;
  return url;
}

function decodeJsEscapes(str: string): string {
  return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  }).replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  }).replace(/\\(.)/g, (_, char) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    if (char === 'b') return '\b';
    if (char === 'f') return '\f';
    return char;
  });
}

function parseYouTubeFromHtml(html: string): ImportedPlaylist | null {
  const found: ImportedTrack[] = [];
  const seen = new Set<string>();
  let title = 'Playlist YouTube';

  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  const collectRenderer = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    // Support for YouTube's new lockupViewModel format
    if (obj.lockupViewModel && typeof obj.lockupViewModel === 'object') {
      const lvm = obj.lockupViewModel as Record<string, any>;
      const videoId = String(lvm.contentId || '');
      const trackTitle = String(lvm.metadata?.lockupMetadataViewModel?.title?.content || '');
      const artist = String(
        lvm.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 
        'Desconocido'
      );
      const cover = String(
        lvm.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || 
        lvm.contentImage?.thumbnailViewModel?.image?.sources?.pop()?.url ||
        `${YT_IMG}/${videoId}/hqdefault.jpg`
      );

      if (videoId.length === 11 && trackTitle && !seen.has(videoId)) {
        seen.add(videoId);
        found.push({
          id: videoId,
          title: trackTitle,
          artist,
          cover,
        });
      }
    }

    const renderers = [
      obj.playlistVideoRenderer,
      obj.playlistPanelVideoRenderer,
      obj.gridVideoRenderer,
      obj.videoRenderer,
      obj.compactVideoRenderer,
      obj.musicResponsiveListItemRenderer,
    ];

    for (const vr of renderers) {
      if (!vr || typeof vr !== 'object') continue;
      const r = vr as Record<string, any>;
      
      let videoId = String(r.videoId || '');
      let trackTitle = '';
      let artist = 'Desconocido';

      // For YouTube Music (musicResponsiveListItemRenderer)
      if (r.playlistItemData?.videoId) {
        videoId = r.playlistItemData.videoId;
        const flexColumns = r.flexColumns || [];
        trackTitle = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
        artist = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 
                 flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map((r:any)=>r.text).join('') || 
                 'Desconocido';
      } else {
        // Normal YouTube (playlistVideoRenderer, etc)
        const titleRuns = r.title as { runs?: { text?: string }[] } | undefined;
        trackTitle =
          titleRuns?.runs?.[0]?.text ||
          (r.title as { simpleText?: string } | undefined)?.simpleText ||
          '';
        artist =
          (r.shortBylineText as { runs?: { text?: string }[] } | undefined)?.runs?.[0]?.text ||
          (r.longBylineText as { runs?: { text?: string }[] } | undefined)?.runs?.[0]?.text ||
          (r.ownerText as { runs?: { text?: string }[] } | undefined)?.runs?.[0]?.text ||
          'Desconocido';
      }

      if (videoId.length === 11 && trackTitle && !seen.has(videoId)) {
        seen.add(videoId);
        found.push({
          id: videoId,
          title: trackTitle,
          artist,
          cover: `${YT_IMG}/${videoId}/hqdefault.jpg`,
        });
      }
    }

    if (Array.isArray(node)) {
      node.forEach(collectRenderer);
    } else {
      Object.values(obj).forEach(collectRenderer);
    }
  };

  // Support for standard YouTube initial data variables
  const markers = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const jsonStart = html.indexOf('{', idx + marker.length);
    if (jsonStart === -1) continue;
    const jsonStr = extractBalancedJson(html, jsonStart);
    if (!jsonStr) continue;
    try {
      collectRenderer(JSON.parse(jsonStr));
    } catch {
      /* siguiente marcador */
    }
    if (found.length > 0) break;
  }

  // Support for YouTube Music initialData.push dynamic scripts
  if (found.length === 0) {
    const initialDataRegex = /initialData\.push\(\s*\{\s*path:\s*['"][^'"]+['"],\s*params:\s*JSON\.parse\(['"][^'"]*['"]\),\s*data:\s*['"]([\s\S]+?)['"]\s*\}\s*\)/g;
    let match;
    while ((match = initialDataRegex.exec(html)) !== null) {
      try {
        const decoded = decodeJsEscapes(match[1]);
        collectRenderer(JSON.parse(decoded));
      } catch {
        /* ignore and continue */
      }
    }
  }

  // Fallback regex videoId matching
  if (found.length === 0) {
    const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
    let m: RegExpExecArray | null;
    const ids: string[] = [];
    while ((m = idRegex.exec(html)) !== null && ids.length < 10000) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
    for (const id of ids) {
      found.push({
        id,
        title: `Pista ${found.length + 1}`,
        artist: 'YouTube',
        cover: `${YT_IMG}/${id}/hqdefault.jpg`,
      });
    }
  }

  if (found.length === 0) return null;
  return { title, tracks: found };
}

export async function parseYouTubePlaylist(pageUrl: string): Promise<ImportedPlaylist> {
  const url = normalizePlaylistUrl(pageUrl);

  let listUrl = url;
  if (url.includes('youtu.be/')) {
    /* enlace de video, no playlist */
  } else if (url.includes('watch?v=') && !url.includes('list=')) {
    throw new Error('Este enlace es de un solo video. Usa un enlace de playlist (?list=...)');
  } else if (!url.includes('list=') && url.includes('/playlist')) {
    listUrl = url;
  }

  let html = '';
  let parsed: ImportedPlaylist | null = null;

  try {
    html = await fetchPageHtml(listUrl);
    parsed = parseYouTubeFromHtml(html);
  } catch (e) {
    console.error('Error fetching YouTube playlist directly:', e);
  }

  // Fallback: If direct fetch failed or parsed 0 tracks, and it was a music.youtube.com link,
  // try fetching it as a www.youtube.com link.
  if ((!parsed || parsed.tracks.length === 0) && url.includes('music.youtube.com')) {
    try {
      const fallbackUrl = listUrl.replace('music.youtube.com', 'www.youtube.com');
      const fallbackHtml = await fetchPageHtml(fallbackUrl);
      parsed = parseYouTubeFromHtml(fallbackHtml);
    } catch (e) {
      console.error('Error fetching YouTube playlist fallback:', e);
    }
  }

  if (!parsed || parsed.tracks.length === 0) {
    throw new Error(
      'No se pudo leer la playlist de YouTube/YouTube Music. Comprueba que sea pública y usa el enlace completo con ?list=',
    );
  }
  return parsed;
}

function collectAppleTracksFromJson(node: unknown, found: ImportedTrack[], seen: Set<string>) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectAppleTracksFromJson(n, found, seen));
    return;
  }

  const obj = node as Record<string, unknown>;
  const attrs = obj.attributes as Record<string, unknown> | undefined;

  const pushTrack = (title: string, artist: string, cover: string) => {
    const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
    if (!title.trim() || seen.has(key)) return;
    seen.add(key);
    found.push({
      id: `search:${title} ${artist}`,
      title,
      artist,
      cover: cover || DEFAULT_COVER,
    });
  };

  if (attrs?.name && attrs?.artistName) {
    const artwork = attrs.artwork as { url?: string } | undefined;
    pushTrack(
      String(attrs.name),
      String(attrs.artistName),
      String(artwork?.url || '')
        .replace('{w}', '600')
        .replace('{h}', '600')
        .replace('{f}', 'jpg'),
    );
  }

  if (
    obj.title &&
    obj.artistName &&
    (obj.contentDescriptor as { kind?: string } | undefined)?.kind === 'song'
  ) {
    const art =
      (obj.artwork as { dictionary?: { url?: string } } | undefined)?.dictionary?.url || '';
    pushTrack(String(obj.title), String(obj.artistName), art);
  }

  Object.values(obj).forEach((v) => collectAppleTracksFromJson(v, found, seen));
}

function scanAppleJsonStrings(html: string, found: ImportedTrack[], seen: Set<string>) {
  const pairRegex =
    /"trackName"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,400}?"artistName"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(html)) !== null) {
    const title = m[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
    const artist = m[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
    pushTrackFromApple(found, seen, title, artist, '');
  }

  const altRegex =
    /"name"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,250}?"artistName"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  while ((m = altRegex.exec(html)) !== null) {
    const title = m[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
    const artist = m[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
    if (title.length > 1 && artist.length > 1) {
      pushTrackFromApple(found, seen, title, artist, '');
    }
  }
}

function pushTrackFromApple(
  found: ImportedTrack[],
  seen: Set<string>,
  title: string,
  artist: string,
  cover: string,
) {
  const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
  if (!title.trim() || seen.has(key)) return;
  seen.add(key);
  found.push({
    id: `search:${title} ${artist}`,
    title,
    artist,
    cover: cover || DEFAULT_COVER,
  });
}

export async function parseAppleMusicPlaylist(pageUrl: string): Promise<ImportedPlaylist> {
  const found: ImportedTrack[] = [];
  const seen = new Set<string>();
  let playlistTitle = 'Playlist Apple Music';

  const parseHtml = (html: string) => {
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      playlistTitle = titleMatch[1]
        .replace(/\s*[-–|]\s*Apple Music.*$/i, '')
        .trim();
    }

    const scriptRegex =
      /<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      try {
        const payload = JSON.parse(scriptMatch[1]);
        if (Array.isArray(payload)) payload.forEach((p) => collectAppleTracksFromJson(p, found, seen));
        else collectAppleTracksFromJson(payload, found, seen);
      } catch {
        /* siguiente */
      }
    }

    const nextDataMatch = html.match(
      /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (nextDataMatch?.[1]) {
      try {
        collectAppleTracksFromJson(JSON.parse(nextDataMatch[1]), found, seen);
      } catch {
        /* ignore */
      }
    }

    try {
      const jsonLdRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
          const ld = JSON.parse(match[1]);
          const entities = Array.isArray(ld) ? ld : [ld];
          for (const entity of entities) {
            if (entity['@type'] !== 'MusicPlaylist' && entity['@type'] !== 'MusicAlbum') continue;
            let trackList = entity.track || entity.tracks;
            if (trackList?.itemListElement) {
              trackList = trackList.itemListElement.map((item: { item?: unknown }) => item.item);
            }
            if (Array.isArray(trackList)) {
              for (const t of trackList) {
                const title = t.name || '';
                const artist = (Array.isArray(t.byArtist) ? t.byArtist[0]?.name : t.byArtist?.name) || 'Desconocido';
                pushTrackFromApple(found, seen, title, artist, entity.image || '');
              }
            }
          }
        } catch {
          /* next */
        }
      }
    } catch {
      /* ignore */
    }

    scanAppleJsonStrings(html, found, seen);
  };

  const base = normalizePlaylistUrl(pageUrl);
  const baseUrls: string[] = [base];

  const match = base.match(/music\.apple\.com\/([a-z]{2})\/playlist/i);
  if (match) {
    const currentStorefront = match[1];
    const alternates = ['us', 'mx', 'do', 'es', 'ar', 'co', 'cl', 'pe', 'br'];
    for (const alt of alternates) {
      if (alt !== currentStorefront.toLowerCase()) {
        baseUrls.push(base.replace(`/music.apple.com/${currentStorefront}/`, `/music.apple.com/${alt}/`));
      }
    }
  }

  const urlsToTry: string[] = [];
  for (const u of baseUrls) {
    urlsToTry.push(u);
    urlsToTry.push(u.replace('https://music.apple.com', 'https://embed.music.apple.com'));
    if (!u.includes('?')) {
      urlsToTry.push(`${u}${u.endsWith('/') ? '' : ''}?app=music`);
    }
  }

  for (const tryUrl of urlsToTry) {
    try {
      const html = await fetchPageHtml(tryUrl);
      parseHtml(html);
      if (found.length > 0) break;
    } catch {
      /* siguiente url */
    }
  }

  const unique = Array.from(
    new Map(found.map((t) => [`${t.title}|${t.artist}`, t])).values(),
  );

  if (unique.length === 0) {
    throw new Error(
      'No se pudo leer la playlist de Apple Music. Usa Compartir → Copiar enlace de una playlist pública.',
    );
  }

  return { title: playlistTitle, tracks: unique };
}

export async function parseSpotifyPlaylist(pageUrl: string): Promise<ImportedPlaylist> {
  const url = normalizePlaylistUrl(pageUrl);
  const idMatch = url.match(/(?:playlist|album)\/([a-zA-Z0-9]+)/);
  if (!idMatch) {
    throw new Error('Enlace de Spotify no válido. Debe ser playlist o álbum.');
  }

  const platformId = idMatch[1];
  const isAlbum = url.includes('album');
  const embedUrl = `https://open.spotify.com/embed/${isAlbum ? 'album' : 'playlist'}/${platformId}`;
  const embedHtml = await fetchPageHtml(embedUrl);

  const nextDataMatch = embedHtml.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );

  if (!nextDataMatch?.[1]) {
    throw new Error('No se pudo leer la playlist de Spotify.');
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const entity = nextData?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList || !Array.isArray(entity.trackList)) {
    throw new Error('Playlist de Spotify vacía o privada.');
  }

  const playlistCover =
    entity.coverArt?.sources?.[0]?.url ||
    'https://cdn-icons-png.flaticon.com/512/174/174872.png';

  const tracks: ImportedTrack[] = entity.trackList.map((t: {
    title: string;
    subtitle: string;
    coverArt?: { sources?: { url?: string }[] };
  }) => ({
    id: `search:${t.title} ${t.subtitle}`,
    title: t.title,
    artist: (t.subtitle || '').replace(/,/g, ', '),
    cover: t.coverArt?.sources?.[0]?.url || playlistCover,
  }));

  return {
    title: entity.name || entity.title || 'Playlist Spotify',
    tracks,
  };
}

export async function parseJsonLdPlaylist(html: string): Promise<ImportedPlaylist | null> {
  const jsonLdRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(match[1]);
      const entities = Array.isArray(ld) ? ld : [ld];
      for (const entity of entities) {
        if (entity['@type'] !== 'MusicPlaylist' && entity['@type'] !== 'MusicAlbum') continue;
        let trackList = entity.track || entity.tracks;
        if (trackList?.itemListElement) {
          trackList = trackList.itemListElement.map((item: { item?: unknown }) => item.item);
        }
        if (!Array.isArray(trackList) || trackList.length === 0) continue;

        const tracks: ImportedTrack[] = trackList.map((t: {
          name: string;
          byArtist?: { name?: string } | { name?: string }[];
        }) => ({
          id: `search:${t.name} ${(Array.isArray(t.byArtist) ? t.byArtist[0]?.name : t.byArtist?.name) || ''}`,
          title: t.name,
          artist:
            (Array.isArray(t.byArtist) ? t.byArtist[0]?.name : t.byArtist?.name) || 'Desconocido',
          cover: entity.image || DEFAULT_COVER,
        }));

        return { title: entity.name || 'Playlist importada', tracks };
      }
    } catch {
      /* siguiente script */
    }
  }
  return null;
}

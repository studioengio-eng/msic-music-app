/**
 * Lyrics Engine
 * Handles LRC/Enhanced LRC parsing, Syllable-level Karaoke timings.
 */

import { fetch } from '@tauri-apps/plugin-http';

export interface LyricLine {
  time: number; // in milliseconds
  text: string;
  words?: LyricWord[]; // For syllable/word-level karaoke
}

export interface LyricWord {
  text: string;
  time: number; // relative/absolute start time in ms
  duration: number; // in ms
}

// ==========================================
// 1. LRC SYNCHRONIZED LYRICS PARSER
// ==========================================

/**
 * Parses raw LRC string into structured LyricLine array.
 * Supports standard line timings: [01:23.45] Lyric text
 * Supports multiple timings: [01:23.45][02:34.56] Lyric text
 * Supports Enhanced LRC syllable-level/word-level timings: [01:23.45] <00:12.34> Word <00:12.56> Another
 */
export function parseLrc(lrcText: string): LyricLine[] {
  const lines = lrcText.split(/\r?\n/);
  const result: LyricLine[] = [];
  
  // Time regex: [mm:ss.xx] or [mm:ss:xx] or [m:ss.xx]
  const timeRegex = /\[(\d{1,3}):(\d{2})[.:](\d{2,3})\]/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Reset regex index
    timeRegex.lastIndex = 0;
    
    const timeTags: number[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    // Parse all time tags at the start of the line
    while ((match = timeRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msPart = match[3];
      const milliseconds = parseInt(msPart.padEnd(3, '0').substring(0, 3), 10);
      
      const totalMs = (minutes * 60 + seconds) * 1000 + milliseconds;
      timeTags.push(totalMs);
      lastIndex = timeRegex.lastIndex;
    }

    if (timeTags.length === 0) continue;

    // The remaining text after all initial timestamps
    const rawContent = trimmed.substring(lastIndex).trim();
    
    // Check for syllable timings, e.g., <00:12.34> or <00:12:34>
    const syllableRegex = /<(\d{2}):(\d{2})[.:](\d{2,3})>([^<]*)/g;
    const words: LyricWord[] = [];
    let cleanText = '';
    let syllMatch: RegExpExecArray | null;
    let firstWordTime: number | null = null;

    if (rawContent.includes('<')) {
      syllableRegex.lastIndex = 0;

      while ((syllMatch = syllableRegex.exec(rawContent)) !== null) {
        const mins = parseInt(syllMatch[1], 10);
        const secs = parseInt(syllMatch[2], 10);
        const msPart = syllMatch[3];
        const ms = parseInt(msPart.padEnd(3, '0').substring(0, 3), 10);
        const wordAbsTime = (mins * 60 + secs) * 1000 + ms;
        const wordText = syllMatch[4];

        if (firstWordTime === null) firstWordTime = wordAbsTime;
        
        const relativeStart = wordAbsTime;
        
        words.push({
          text: wordText,
          time: relativeStart,
          duration: 0 // Will adjust duration of previous words
        });

        if (words.length > 1) {
          words[words.length - 2].duration = relativeStart - words[words.length - 2].time;
        }

        cleanText += wordText;
      }

      // Cap last word duration dynamically
      if (words.length > 0) {
        words[words.length - 1].duration = 1000; // fallback duration for final syllable
      }
    } else {
      cleanText = rawContent;
    }

    // Skip technical tags like [by: AntiGravity] or [ar: Artist]
    if (cleanText.startsWith('[') || (cleanText.includes(':') && !cleanText.includes(' '))) {
      continue;
    }

    for (const time of timeTags) {
      // For each time tag, create a duplicate entry
      const actualWords = words.map(w => ({
        ...w,
        time: w.time + time // Shift word absolute time relative to the line start
      }));

      result.push({
        time,
        text: cleanText,
        words: actualWords.length > 0 ? actualWords : undefined
      });
    }
  }

  // Sort by time
  return result.sort((a, b) => a.time - b.time);
}

/**
 * Strips YouTube-specific suffixes, brackets, topics, and annotations to isolate clean song metadata.
 */
export function cleanTextForLyrics(text: string, artist?: string): string {
  if (!text) return '';
  let cleaned = text
    // Remove text inside parentheses or brackets containing video/audio markers
    .replace(/\s*[\(\[][Vv]ídeo\s*[Oo]ficial[\)\]]/gi, '')
    .replace(/\s*[\(\[][Oo]ficial\s*[Vv]ideo[\)\]]/gi, '')
    .replace(/\s*[\(\[][Oo]fficial\s*[Mm]usic\s*[Vv]ideo[\)\]]/gi, '')
    .replace(/\s*[\(\[][Oo]fficial\s*[Vv]ideo[\)\]]/gi, '')
    .replace(/\s*[\(\[][Oo]fficial\s*[Aa]udio[\)\]]/gi, '')
    .replace(/\s*[\(\[][Vv]ideo\s*[Cc]lip[\)\]]/gi, '')
    .replace(/\s*[\(\[][Vv]ideoclip\s*[Oo]ficial[\)\]]/gi, '')
    .replace(/\s*[\(\[][Ll]yric\s*[Vv]ideo[\)\]]/gi, '')
    .replace(/\s*[\(\[][Ll]yrics[\)\]]/gi, '')
    .replace(/\s*[\(\[][Oo]ficial[\)\]]/gi, '')
    .replace(/\s*[\(\[][Oo]fficial[\)\]]/gi, '')
    .replace(/\s*[\(\[][Hh][Qq][\)\]]/gi, '')
    .replace(/\s*[\(\[][Hh][Dd][\)\]]/gi, '')
    .replace(/\s*[\(\[][Mm]\/[Vv][\)\]]/gi, '')
    .replace(/\s*[\(\[][Vv]\/[Rg][\)\]]/gi, '')
    .replace(/\s*official\s*audio/gi, '')
    .replace(/\s*official\s*video/gi, '')
    .replace(/\s*lyric\s*video/gi, '')
    .replace(/\s*video\s*oficial/gi, '')
    .replace(/\s*videoclip\s*oficial/gi, '')
    // Remove Topic suffix from YouTube auto-generated releases
    .replace(/\s*-\s*Topic$/i, '')
    // Remove clean spacing and leading/trailing dashes
    .replace(/\s+/g, ' ')
    .trim();

  // If artist is provided, try to strip "Artist - " or " - Artist" from the title
  if (artist) {
    const cleanArt = artist.replace(/\s*-\s*Topic$/i, '').trim();
    if (cleanArt) {
      const escapedArtist = cleanArt.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const startRegex = new RegExp(`^${escapedArtist}\\s*[-–—]\\s*`, 'i');
      const endRegex = new RegExp(`\\s*[-–—]\\s*${escapedArtist}$`, 'i');
      cleaned = cleaned.replace(startRegex, '').replace(endRegex, '').trim();
    }
  }

  return cleaned;
}

function parseLrcLibResult(data: any): { lines: LyricLine[]; plainText: string } | null {
  if (!data) return null;
  if (data.syncedLyrics) {
    const parsed = parseLrc(data.syncedLyrics);
    return {
      lines: parsed,
      plainText: data.plainLyrics || parsed.map(p => p.text).join('\n')
    };
  } else if (data.plainLyrics) {
    const plainLines = data.plainLyrics.split(/\r?\n/).map((text: string, idx: number) => ({
      time: idx * 3500, // guess line intervals of 3.5s
      text: text.trim()
    })).filter((l: any) => l.text);
    
    return {
      lines: plainLines,
      plainText: data.plainLyrics
    };
  }
  return null;
}

/**
 * Parses and returns LRCLIB metadata using a robust three-stage search pipeline.
 */
export async function fetchLyricsFromLrcLib(
  title: string,
  artist: string,
  durationSeconds?: number
): Promise<{ lines: LyricLine[]; plainText: string } | null> {
  const cleanArtist = cleanTextForLyrics(artist);
  const cleanTitle = cleanTextForLyrics(title, cleanArtist);

  if (!cleanTitle) return null;

  const userAgent = 'Msic/1.4 (https://github.com/Antigravity/msic)';

  // Stage 1: Exact Match (api/get)
  try {
    let url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}`;
    if (durationSeconds && durationSeconds > 0) {
      url += `&duration=${Math.round(durationSeconds)}`;
    }
    const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (response.ok) {
      const data = JSON.parse(await response.text());
      const res = parseLrcLibResult(data);
      if (res) return res;
    }
  } catch (err) {
    console.error('LrcLib stage 1 get error:', err);
  }

  // Stage 2: Targeted Search (api/search with specific fields)
  try {
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (response.ok) {
      const results = JSON.parse(await response.text());
      if (Array.isArray(results) && results.length > 0) {
        for (const record of results) {
          const res = parseLrcLibResult(record);
          if (res) return res;
        }
      }
    }
  } catch (err) {
    console.error('LrcLib stage 2 search error:', err);
  }

  // Stage 3: Full-text Search (api/search fuzzy query)
  try {
    const query = [cleanArtist, cleanTitle].filter(Boolean).join(' ');
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (response.ok) {
      const results = JSON.parse(await response.text());
      if (Array.isArray(results) && results.length > 0) {
        for (const record of results) {
          const res = parseLrcLibResult(record);
          if (res) return res;
        }
      }
    }
  } catch (err) {
    console.error('LrcLib stage 3 fuzzy search error:', err);
  }

  return null;
}

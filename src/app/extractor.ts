import { fetch } from '@tauri-apps/plugin-http';

const A = 'https://www.y';
const B = 'out';
const C = 'ube.com';
const PROVIDER = A + B + C;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Busca el ID del medio scrapeando la página de resultados
 */
export async function searchMediaId(query: string): Promise<string | null> {
    try {
        const res = await fetch(`${PROVIDER}/results?search_query=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
        });
        const html = await res.text();
        const match = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
        if (match && match[1]) {
            console.log("[Extractor] Video ID encontrado:", match[1]);
            return match[1];
        }
        console.error("[Extractor] No se encontró video ID");
    } catch (e) {
        console.error("[Extractor] Search Error:", e);
    }
    return null;
}

/**
 * Cuenta llaves para extraer JSON balanceado
 */
function extractBalancedJSON(text: string, startIndex: number): string | null {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) return text.substring(startIndex, i + 1); }
    }
    return null;
}

/**
 * Extrae la URL de audio. Intenta 3 métodos en cascada:
 * 1. Embed page (tiene URLs directas)
 * 2. Watch page HTML parsing
 * 3. Iframe embed (siempre funciona, usa el reproductor oficial de YouTube)
 */
export async function extractNativeAudio(videoId: string): Promise<string | null> {
    console.log("[Extractor] Iniciando extracción para:", videoId);

    // Método 1: Embed page - suele tener URLs completas
    const embedResult = await tryEmbedPage(videoId);
    if (embedResult) return embedResult;

    // Método 2: Watch page HTML
    const watchResult = await tryWatchPage(videoId);
    if (watchResult) return watchResult;

    // Método 3: Iframe embed (fallback garantizado)
    console.log("[Extractor] Usando reproductor embebido como fallback");
    return `IFRAME:${videoId}`;
}

/**
 * Método 1: Extraer del embed page
 */
async function tryEmbedPage(videoId: string): Promise<string | null> {
    try {
        console.log("[Extractor] Intentando vía embed page...");
        const res = await fetch(`${PROVIDER}/embed/${videoId}`, {
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
        });
        if (!res.ok) return null;

        const html = await res.text();
        console.log("[Extractor] Embed HTML recibido, tamaño:", html.length);

        // En la embed page, los datos suelen estar en ytInitialPlayerResponse o en ytcfg
        const result = extractStreamingFromHTML(html);
        if (result) {
            console.log("[Extractor] ✅ Audio extraído vía embed page!");
            return result;
        }
    } catch (e) {
        console.error("[Extractor] Embed page error:", e);
    }
    return null;
}

/**
 * Método 2: Extraer del watch page
 */
async function tryWatchPage(videoId: string): Promise<string | null> {
    try {
        console.log("[Extractor] Intentando vía watch page...");
        const res = await fetch(`${PROVIDER}/watch?v=${videoId}`, {
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
        });
        if (!res.ok) return null;

        const html = await res.text();
        const result = extractStreamingFromHTML(html);
        if (result) {
            console.log("[Extractor] ✅ Audio extraído vía watch page!");
            return result;
        }

        // Último intento: buscar URLs en bruto en el HTML
        const rawResult = extractRawUrl(html);
        if (rawResult) {
            console.log("[Extractor] ✅ URL bruta encontrada en el HTML!");
            return rawResult;
        }
    } catch (e) {
        console.error("[Extractor] Watch page error:", e);
    }
    return null;
}

/**
 * Busca ytInitialPlayerResponse o similar en el HTML y extrae URLs de audio
 */
function extractStreamingFromHTML(html: string): string | null {
    // Buscar en múltiples variables conocidas
    const markers = ['ytInitialPlayerResponse', 'ytplayer.config'];
    
    for (const marker of markers) {
        const idx = html.indexOf(marker);
        if (idx === -1) continue;

        const jsonStart = html.indexOf('{', idx);
        if (jsonStart === -1) continue;

        const jsonString = extractBalancedJSON(html, jsonStart);
        if (!jsonString) continue;

        try {
            const data = JSON.parse(jsonString);
            
            // Navegar la estructura - puede estar en la raíz o dentro de args
            const streamingData = data.streamingData || data.args?.player_response?.streamingData;
            if (!streamingData) continue;

            const allFormats = [
                ...(streamingData.formats || []),
                ...(streamingData.adaptiveFormats || [])
            ];

            // Buscar formatos con URL directa (audio O video - el <audio> puede reproducir video)
            const withUrl = allFormats
                .filter((f: any) => f.url)
                .sort((a: any, b: any) => {
                    // Priorizar audio sobre video
                    const aIsAudio = a.mimeType?.startsWith('audio/') ? 1 : 0;
                    const bIsAudio = b.mimeType?.startsWith('audio/') ? 1 : 0;
                    if (aIsAudio !== bIsAudio) return bIsAudio - aIsAudio;
                    return (b.bitrate || 0) - (a.bitrate || 0);
                });

            if (withUrl.length > 0) {
                console.log("[Extractor] Formato con URL directa:", withUrl[0].mimeType);
                return withUrl[0].url;
            }

            // Buscar signatureCipher
            const withCipher = allFormats.filter((f: any) => f.signatureCipher || f.cipher);
            if (withCipher.length > 0) {
                console.log("[Extractor] Formatos con cipher encontrados:", withCipher.length);
                // No podemos descifrar fácilmente, marcar para iframe
                return null;
            }

            console.log("[Extractor] Formatos encontrados pero sin URLs:", allFormats.length);
            if (allFormats.length > 0) {
                console.log("[Extractor] Claves:", Object.keys(allFormats[0]).join(', '));
            }
        } catch (e) {
            continue;
        }
    }
    return null;
}

/**
 * Busca URLs de googlevideo directamente en el HTML como último recurso
 */
function extractRawUrl(html: string): string | null {
    // YouTube a veces embebe URLs de googlevideo directamente
    const patterns = [
        /https?:\\\/\\\/[a-z0-9-]+\.googlevideo\.com\\\/videoplayback[^"'\\]*/,
        /https?:\/\/[a-z0-9-]+\.googlevideo\.com\/videoplayback[^"'\s]*/
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
            let url = match[0]
                .replace(/\\\//g, '/')
                .replace(/\\u0026/g, '&')
                .replace(/\\u003d/gi, '=');
            
            // Decodificar URL si está doble-codificada (%3F, %26, %3D, etc.)
            try {
                url = decodeURIComponent(url);
            } catch (e) {
                // Si falla decodeURIComponent, intentar decodificación manual
                url = url
                    .replace(/%3F/gi, '?')
                    .replace(/%26/gi, '&')
                    .replace(/%3D/gi, '=')
                    .replace(/%252C/gi, ',')
                    .replace(/%253D/gi, '=');
            }
            
            console.log("[Extractor] URL de googlevideo encontrada en bruto");
            return url;
        }
    }
    return null;
}

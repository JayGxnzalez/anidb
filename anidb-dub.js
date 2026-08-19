/**
 * AniDB-DUB — anidb.app English-dub source module (Sora / Shirox)
 *
 * Built on the resilient (Document 1) base:
 *   - own soraFetch wrapper (fetchv2 -> raw fetch fallback), no external status coupling
 *   - parallel embed resolution (Promise.all)
 *   - multi-regex fallbacks for search / details / m3u8
 *
 * Dub-only: extractStreamUrl keeps English-dub audio tracks only.
 * Subtitle contract: returns { subtitles, subtitlesHeaders, allSubtitles }
 *   - subtitles       : primary/default track (STRING)
 *   - subtitlesHeaders: headers for the primary track
 *   - allSubtitles    : full array that populates the picker
 */

const BASE_URL = 'https://anidb.app';
const BROWSE_URL = `${BASE_URL}/browse?q=`;
const SUGGEST_URL = `${BASE_URL}/search/suggestions?q=`;
const EPISODES_API = `${BASE_URL}/api/frontend/anime/%s/episodes`;
const LANGUAGES_API = `${BASE_URL}/api/frontend/episode/%s/languages`;

// English-dub audio codes/labels. anidb serves audio languages via the
// languages API, so 'eng' here is the English DUB track (jpn == sub).
const DUB_CODES = new Set(['eng', 'en', 'en-us', 'english', 'dub']);

/* MAIN FUNCTIONS */

/**
 * Searches anidb.app for anime titles matching the given keyword.
 * Returns a JSON string array of {title, image, href} objects.
 */
async function searchResults(keyword) {
    try {
        const query = (keyword || '').trim();
        if (!query) return JSON.stringify([]);

        // &sort=order_top borrowed from the class-based module: better ordering.
        const browseSrc = await fetchText(`${BROWSE_URL}${encodeURIComponent(query)}&sort=order_top`);
        const fromBrowse = parseBrowseCards(browseSrc);
        if (fromBrowse.length > 0) return JSON.stringify(fromBrowse);

        const suggestSrc = await fetchText(`${SUGGEST_URL}${encodeURIComponent(query)}`);
        const fromSuggest = parseBrowseCards(suggestSrc);
        if (fromSuggest.length > 0) return JSON.stringify(fromSuggest);

        return JSON.stringify([]);
    } catch (error) {
        console.log('Search error: ' + error);
        return JSON.stringify([]);
    }
}

/**
 * Fetches the anime page and extracts description, airdate and alternative titles.
 * Returns a JSON array with a single {description, airdate, aliases} object.
 */
async function extractDetails(url) {
    try {
        const response = await soraFetch(url);
        if (!response) return JSON.stringify([detailsFallback()]);
        const html = await response.text();

        const description = extractFirst(html, /<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i)
            || extractFirst(html, /<meta[^>]*name="description"[^>]*content="([^"]+)"/i)
            || extractFirst(html, /<p\s+class="[^"]*(?:leading-relaxed|description|plot|summary|text-faint)[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
            || extractFirst(html, /<div\s+class="[^"]*(?:description|plot|summary|synopsis)[^"]*">([\s\S]*?)<\/div>/i)
            || 'No description available';

        const airdate = extractDt(html, 'Aired')
            || extractDt(html, 'Season')
            || extractDt(html, 'Released')
            || extractFirst(html, /<div class="text-sm"><dt[^>]*name="(?:Year|Airdate|Date)"[^>]*>([^<]+)<\/dt>/i)
            || 'Unknown';

        const aliases = extractDt(html, 'Synonyms')
            || extractDt(html, 'Alternative')
            || extractDt(html, 'Titles')
            || 'No alternative titles';

        return JSON.stringify([{
            description: cleanText(description),
            airdate: cleanText(airdate),
            aliases: cleanText(aliases)
        }]);
    } catch (error) {
        console.log('Details error: ' + error);
        return JSON.stringify([detailsFallback()]);
    }
}

function detailsFallback() {
    return {
        description: 'No description available',
        airdate: 'Unknown',
        aliases: 'No alternative titles'
    };
}

/**
 * Extracts the list of episodes for an anime using the public JSON API.
 * href format: `${BASE_URL}/episode/${epId}` (parsed back out in extractStreamUrl).
 */
async function extractEpisodes(url) {
    try {
        const animeId = parseAnimeId(url);
        if (!animeId) return JSON.stringify([]);

        const response = await soraFetch(EPISODES_API.replace('%s', animeId));
        if (!response) return JSON.stringify([]);
        const data = await response.json();

        const rawEpisodes = (data && (Array.isArray(data.episodes) ? data.episodes : Array.isArray(data.data) ? data.data : Array.isArray(data.list) ? data.list : [])) || [];
        if (!Array.isArray(rawEpisodes)) return JSON.stringify([]);

        const episodes = rawEpisodes
            .map((ep, index) => {
                const number = ep.number !== undefined ? parseInt(ep.number, 10) : index + 1;
                const epId = ep.id || ep.episode_id || ep.episodeId;
                if (isNaN(number) || !epId) return null;
                return {
                    href: `${BASE_URL}/episode/${epId}`,
                    number: number
                };
            })
            .filter(Boolean);

        return JSON.stringify(episodes);
    } catch (error) {
        console.log('Episodes error: ' + error);
        return JSON.stringify([]);
    }
}

/**
 * Resolves an episode to its English-dub HLS stream(s) and all subtitle tracks.
 * @param {string} url - episode href (https://anidb.app/episode/{id}).
 * @returns {string} JSON { streams, subtitles, subtitlesHeaders, allSubtitles }.
 */
async function extractStreamUrl(url) {
    try {
        const episodeMatch = String(url || '').match(/\/episode\/(\d+)/);
        if (!episodeMatch) return JSON.stringify(emptyStreamResult());

        const epId = episodeMatch[1];
        const response = await soraFetch(LANGUAGES_API.replace('%s', epId));
        if (!response) return JSON.stringify(emptyStreamResult());
        const data = await response.json();

        const rawLangs = (data && (Array.isArray(data.languages) ? data.languages : Array.isArray(data.data) ? data.data : Array.isArray(data.streams) ? data.streams : [])) || [];
        if (!Array.isArray(rawLangs)) return JSON.stringify(emptyStreamResult());

        const languages = rawLangs
            .map((lang) => ({
                code: (lang.code || lang.language || '').toLowerCase(),
                name: lang.name || lang.label,
                embed_url: lang.embed_url || lang.url || lang.file
            }))
            .filter((l) => l.code && l.embed_url);

        // DUB-ONLY: keep English-dub audio tracks only.
        const dubLangs = languages.filter(isDub);
        if (dubLangs.length === 0) return JSON.stringify(emptyStreamResult());

        // Resolve every dub embed in parallel -> master playlist + subtitle tracks.
        const resolved = await Promise.all(dubLangs.map(async (lang) => {
            try {
                const { master, subs } = await resolveEmbed(lang.embed_url);
                if (!master) return null;
                return {
                    title: prettifyLangLabel(lang),
                    streamUrl: master,
                    headers: makeStreamHeaders(),
                    language: lang.code,
                    subs: subs || []
                };
            } catch (e) {
                console.log('Embed resolve error: ' + (lang.code || lang.name) + ' -> ' + e);
                return null;
            }
        }));

        const streams = [];
        const seenStream = new Set();
        const allSubtitles = [];
        const seenSub = new Set();

        resolved.forEach((s) => {
            if (!s || !s.streamUrl) return;

            const streamKey = s.language || s.streamUrl;
            if (!seenStream.has(streamKey)) {
                seenStream.add(streamKey);
                streams.push({ title: s.title, streamUrl: s.streamUrl, headers: s.headers });
            }

            (s.subs || []).forEach((sub) => {
                if (!sub || !sub.url || seenSub.has(sub.url)) return;
                seenSub.add(sub.url);
                allSubtitles.push({
                    url: sub.url,
                    label: sub.label || 'Subtitle',
                    kind: sub.kind || 'captions',
                    headers: makeStreamHeaders()
                });
            });
        });

        const primary = pickPrimarySub(allSubtitles);
        return JSON.stringify({
            streams: streams,
            subtitles: primary ? primary.url : '',
            subtitlesHeaders: primary ? primary.headers : makeStreamHeaders(),
            allSubtitles: allSubtitles
        });
    } catch (error) {
        console.log('Stream error: ' + error);
        return JSON.stringify(emptyStreamResult());
    }
}

/* HELPERS */

function emptyStreamResult() {
    return { streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] };
}

function isDub(lang) {
    const code = (lang.code || '').toLowerCase();
    const name = (lang.name || '').toLowerCase();
    if (DUB_CODES.has(code)) return true;
    return /\b(dub|english)\b/.test(code) || /\b(dub|english)\b/.test(name);
}

// Resolve an anidb.app embed page to { master (m3u8 url), subs [{url,label,kind}] }.
async function resolveEmbed(embedUrl) {
    if (!embedUrl) return { master: null, subs: [] };

    // Already a media URL.
    if (/\.m3u8/i.test(embedUrl)) return { master: embedUrl, subs: [] };

    const response = await soraFetch(embedUrl);
    if (!response) return { master: null, subs: [] };
    const html = await response.text();

    const master = extractFirst(html, /sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i)
        || extractFirst(html, /file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
        || extractFirst(html, /'(https?:\/\/[^']+\.m3u8(?:[^']*))'/i)
        || extractFirst(html, /["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i)
        || extractFirst(html, /playlist\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i)
        || extractFirst(html, /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);

    return {
        master: master ? decodeHtml(master) : null,
        subs: extractSubtitleTracks(html)
    };
}

// Parse subtitle tracks out of the embed's player config.
// Primary path: JWPlayer/hls.js `tracks: [...]`. Fallback: bare sub-file URLs.
function extractSubtitleTracks(html) {
    const out = [];
    const seen = new Set();
    if (!html) return out;

    const tracksBlock = html.match(/tracks\s*:\s*(\[[\s\S]*?\])/i) || html.match(/"tracks"\s*:\s*(\[[\s\S]*?\])/i);
    if (tracksBlock && tracksBlock[1]) {
        const block = tracksBlock[1];
        const objRe = /\{[^{}]*\}/g;
        let m;
        while ((m = objRe.exec(block)) !== null) {
            const obj = m[0];
            const file = extractFirst(obj, /(?:file|src)\s*:\s*['"]([^'"]+)['"]/i)
                || extractFirst(obj, /["'](?:file|src)["']\s*:\s*["']([^"']+)["']/i);
            if (!file) continue;

            const kindRaw = (extractFirst(obj, /kind\s*:\s*['"]([^'"]+)['"]/i)
                || extractFirst(obj, /["']kind["']\s*:\s*["']([^"']+)["']/i) || '').toLowerCase();

            // Skip thumbnails / chapters / non-subtitle tracks.
            if (kindRaw && !/caption|subtitle|sub/.test(kindRaw)) continue;

            const url = decodeHtml(file);
            const looksLikeSub = /\.(vtt|srt|ass|ssa)(\?|$)/i.test(url);
            if (!looksLikeSub && !kindRaw) continue; // ambiguous entry, skip
            if (seen.has(url)) continue;
            seen.add(url);

            const label = extractFirst(obj, /label\s*:\s*['"]([^'"]+)['"]/i)
                || extractFirst(obj, /["']label["']\s*:\s*["']([^"']+)["']/i)
                || 'Subtitle';

            out.push({ url: url, label: cleanText(label), kind: 'captions' });
        }
    }

    if (out.length === 0) {
        const re = /(https?:\/\/[^\s"'<>]+\.(?:vtt|srt|ass|ssa)(?:\?[^\s"'<>]*)?)/gi;
        let mm;
        while ((mm = re.exec(html)) !== null) {
            const u = decodeHtml(mm[1]);
            if (seen.has(u)) continue;
            seen.add(u);
            out.push({ url: u, label: 'Subtitle', kind: 'captions' });
        }
    }

    return out;
}

// Choose the default/primary track: prefer an English label, else the first.
function pickPrimarySub(list) {
    if (!list || list.length === 0) return null;
    const eng = list.find((s) => /eng/i.test(s.label));
    return eng || list[0];
}

function prettifyLangLabel(lang) {
    const map = {
        eng: 'English (DUB)',
        en: 'English (DUB)',
        'en-us': 'English (DUB)'
    };
    if (map[lang.code]) return map[lang.code];
    if (lang.name) return lang.name;
    return (lang.code || 'English').toUpperCase() + ' (DUB)';
}

function parseBrowseCards(html) {
    const results = [];
    const seen = new Set();

    const regexes = [
        /<a[^>]*href="(https?:\/\/anidb\.app\/anime\/[^"]+)"[^>]*class="[^"]*anime-card[^"]*"[^>]*title="([^"]*)"[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<\/a>/gi,
        /<a[^>]*href="(https?:\/\/anidb\.app\/anime\/[^"]+)"[^>]*title="([^"]*)"[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<\/a>/gi,
        /<a[^>]*href="(https?:\/\/anidb\.app\/anime\/[^"]+)"[\s\S]*?<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<\/a>/gi,
        /<a[^>]*href="(https?:\/\/anidb\.app\/anime\/[^"]+)"[\s\S]*?<\/a>/gi
    ];

    for (const rx of regexes) {
        let cardMatch;
        while ((cardMatch = rx.exec(html)) !== null) {
            const href = cardMatch[1];
            let title = cleanText(cardMatch[2] || cardMatch[3] || '');
            let image = decodeHtml(cardMatch[3] || cardMatch[2] || '').trim();

            if (image && !image.startsWith('http') && title && title.startsWith('http')) {
                const temp = title;
                title = image;
                image = temp;
            }

            if (!title) {
                const slugMatch = href.match(/\/([^/]+)$/);
                title = slugMatch ? slugMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ') : 'Unknown Anime';
            }

            if (!href || seen.has(href)) continue;
            seen.add(href);
            results.push({
                title: cleanText(title),
                image: image.startsWith('http') ? image : '',
                href
            });
        }
        if (results.length > 0) break;
    }

    // Recover missing poster images via a positional scan (from the class-based module).
    results.forEach((r) => {
        if (r.image) return;
        const idx = html.indexOf(r.href);
        if (idx === -1) return;
        const chunk = html.substring(idx, idx + 800);
        const img = chunk.match(/<img[^>]*src="([^"]+)"/i);
        if (img && img[1] && img[1].startsWith('http')) r.image = decodeHtml(img[1]);
    });

    return results;
}

// anidb.app anime URLs are /anime/<slug>-<numericId>. Return the numeric id.
function parseAnimeId(url) {
    const m = String(url || '').match(/\/anime\/[^/]+-(\d+)\/?$/i);
    if (m && m[1]) return m[1];
    const fallback = String(url || '').match(/-(\d+)\/?$/);
    return fallback ? fallback[1] : '';
}

// Grab the <dd> value following a <dt> with the given label, with fallbacks.
function extractDt(html, label) {
    const re = new RegExp(`<dt[^>]*>[^<]*${label}[^<]*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`, 'i');
    const m = (html || '').match(re);
    if (m && m[1]) return cleanText(m[1]);

    const altRe = new RegExp(`(?:<dt[^>]*>|<span[^>]*>)\\s*${label}\\s*(?:<\\/dt>|<\\/span>)\\s*(?:<dd[^>]*>|<span[^>]*>)([\\s\\S]*?)(?:<\\/dd>|<\\/span>)`, 'i');
    const altM = (html || '').match(altRe);
    if (altM && altM[1]) return cleanText(altM[1]);

    return '';
}

function extractFirst(text, regex) {
    const match = (text || '').match(regex);
    return match ? match[1] : '';
}

function decodeHtml(text) {
    return String(text || '')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#038;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function cleanText(text) {
    return decodeHtml(String(text || ''))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+(>|$)/g, '')
        .replace(/\s+\n/g, '\n')
        .replace(/\n\s+/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

// Stream/subtitle headers that match the anidb.app playback origin.
function makeStreamHeaders() {
    return {
        "Referer": BASE_URL + '/',
        "Origin": BASE_URL,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    };
}

async function soraFetch(url, options) {
    const opts = options || {};
    const mergedHeaders = mergeHeaders(url, opts);
    const method = opts.method || 'GET';
    const body = typeof opts.body === 'undefined' ? null : opts.body;

    try {
        return await fetchv2(url, mergedHeaders, method, body);
    } catch (e) {
        try {
            const text = await fetch(url, {
                method: method,
                headers: mergedHeaders,
                body: body
            });
            return {
                text: async () => text,
                json: async () => JSON.parse(text)
            };
        } catch (error) {
            console.log('soraFetch error: ' + error);
            return null;
        }
    }
}

async function fetchText(url) {
    const response = await soraFetch(url);
    if (!response) return '';
    return await response.text();
}

function mergeHeaders(url, opts) {
    const base = opts.headers || {};
    const defaults = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    const host = String(url || '').replace(/^https?:\/\//, '').split('/')[0] || '';
    if (/anidb\.app|hls\.anidb\.app/i.test(host)) {
        defaults['Accept'] = '*/*';
        defaults['Accept-Language'] = 'en-US,en;q=0.9';
        defaults['Referer'] = BASE_URL + '/';
        defaults['Origin'] = BASE_URL;
    }

    const out = {};
    let k;
    for (k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = defaults[k];
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    return out;
}

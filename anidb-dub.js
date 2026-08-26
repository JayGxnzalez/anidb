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

// Dub-only module returns a single stream, so a provider-style name is noise.
const STREAM_LABEL = 'English Dub';

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

        // Slug is already in the anime URL — carry title, season and a RELATIVE
        // episode number on the href so extractStreamUrl can look up subtitles
        // without extra fetches.
        const slug = parseAnimeSlug(url);
        const season = parseSeasonFromSlug(slug);
        const searchTitle = slugToTitle(slug);

        const response = await soraFetch(EPISODES_API.replace('%s', animeId));
        if (!response) return JSON.stringify([]);
        const data = await response.json();

        const rawEpisodes = (data && (Array.isArray(data.episodes) ? data.episodes : Array.isArray(data.data) ? data.data : Array.isArray(data.list) ? data.list : [])) || [];
        if (!Array.isArray(rawEpisodes)) return JSON.stringify([]);

        // anidb uses ABSOLUTE numbering on split-cour shows (Attack on Titan S2
        // is 26..37). Subtitle sites index by season-relative number, so derive
        // an offset from the lowest episode, matching what the Aniyomi source does.
        let minNumber = 0;
        rawEpisodes.forEach((ep, index) => {
            const n = ep && ep.number !== undefined ? parseInt(ep.number, 10) : index + 1;
            if (!isNaN(n) && (minNumber === 0 || n < minNumber)) minNumber = n;
        });
        const offset = minNumber > 1 ? minNumber - 1 : 0;

        const episodes = rawEpisodes
            .map((ep, index) => {
                const number = ep.number !== undefined ? parseInt(ep.number, 10) : index + 1;
                const epId = ep.id || ep.episode_id || ep.episodeId;
                if (isNaN(number) || !epId) return null;
                const relative = number - offset;
                return {
                    href: `${BASE_URL}/episode/${epId}?t=${encodeURIComponent(searchTitle)}&s=${season}&n=${relative}`,
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

        // Log the raw shape once so we can see whether anidb ships subtitle
        // tracks in this JSON (like AnimexOne's `tracks`) rather than in the embed.
        try { console.log('[AniDB-DUB] languages raw: ' + JSON.stringify(rawLangs).substring(0, 700)); } catch (e) {}

        const languages = rawLangs
            .map((lang) => ({
                code: (lang.code || lang.language || '').toLowerCase(),
                name: lang.name || lang.label,
                embed_url: lang.embed_url || lang.url || lang.file,
                raw: lang
            }))
            .filter((l) => l.code && l.embed_url);

        // DUB-ONLY: keep English-dub audio tracks only.
        const dubLangs = languages.filter(isDub);
        if (dubLangs.length === 0) return JSON.stringify(emptyStreamResult());

        // Kick the external subtitle lookup off NOW so it overlaps the embed +
        // master-playlist fetches below. Total cost is max(streams, subs), not
        // the sum. Sora has no setTimeout, so there's no timer to race against —
        // overlapping the work IS the speed strategy.
        const meta = parseEpisodeMeta(url);
        const externalSubsPromise = fetchExternalSubs(meta);

        // Resolve every dub embed in parallel -> master playlist + subtitle tracks.
        const resolved = await Promise.all(dubLangs.map(async (lang) => {
            try {
                // Subs may come from the languages API itself (AnimexOne-style)
                // or from the embed's player config. Take both.
                const apiSubs = subsFromApiEntry(lang.raw);
                const { master, subs } = await resolveEmbed(lang.embed_url);
                if (!master) return null;
                // Aniyomi's AniDB source hands the master playlist to PlaylistUtils,
                // which reads #EXT-X-MEDIA:TYPE=SUBTITLES entries. Do the same.
                const hlsSubs = await subsFromMasterPlaylist(master);
                return {
                    title: prettifyLangLabel(lang),
                    streamUrl: master,
                    headers: makeStreamHeaders(),
                    language: lang.code,
                    subs: apiSubs.concat(subs || []).concat(hlsSubs || [])
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
                    label: cleanText(sub.label || 'Subtitle'),
                    kind: sub.kind || 'captions',
                    headers: makeStreamHeaders(),
                    isDefault: !!sub.isDefault
                });
            });
        });

        // Await the overlapped lookup — by now it has usually already settled.
        let externalSubs = [];
        try { externalSubs = await externalSubsPromise; } catch (e) { externalSubs = []; }
        externalSubs.forEach((sub) => {
            if (!sub || !sub.url || seenSub.has(sub.url)) return;
            seenSub.add(sub.url);
            allSubtitles.push({
                url: sub.url,
                label: cleanText(sub.label || 'English'),
                kind: 'captions',
                headers: sub.headers || {},
                isDefault: !!sub.isDefault
            });
        });

        const primary = pickPrimarySub(allSubtitles);
        const primaryUrl = primary ? primary.url : '';

        // Emit both shapes — different clients read different keys (§7).
        // English first: apps auto-load the first entry.
        const subtitlePairs = [];
        allSubtitles.forEach((s) => { subtitlePairs.push(s.label, s.url); });

        console.log('[AniDB-DUB] streams=' + streams.length + ' subs=' + allSubtitles.length);
        return JSON.stringify({
            streams: streams,
            subtitle: primaryUrl,
            subtitles: primaryUrl,
            subtitlePairs: subtitlePairs,
            subtitleHeaders: primary ? primary.headers : {},
            subtitlesHeaders: primary ? primary.headers : makeStreamHeaders(),
            allSubtitles: allSubtitles
        });
    } catch (error) {
        console.log('Stream error: ' + error);
        return JSON.stringify(emptyStreamResult());
    }
}

/* HELPERS */

// Shirox logs read `currentStream.subtitle` (singular) alongside
// `currentStream.allSubtitles`, so emit both spellings of the primary key.
function emptyStreamResult() {
    return { streams: [], subtitle: '', subtitles: '', subtitlesHeaders: {}, allSubtitles: [] };
}

// Pull subtitle tracks straight off a languages-API entry, the way AnimexOne
// reads `data.tracks`. Checks the field names anidb plausibly uses and
// filters out thumbnail/preview tracks.
function subsFromApiEntry(raw) {
    const out = [];
    if (!raw || typeof raw !== 'object') return out;

    const candidates = [raw.tracks, raw.subtitles, raw.subs, raw.captions, raw.subtitle_tracks];
    candidates.forEach((list) => {
        if (!Array.isArray(list)) return;
        list.forEach((t) => {
            if (!t) return;
            const url = typeof t === 'string' ? t : (t.url || t.file || t.src);
            if (!url) return;
            const kind = String((typeof t === 'object' && (t.kind || t.type)) || '').toLowerCase();
            if (kind && /thumbnail|preview|sprite|chapter/.test(kind)) return;
            out.push({
                url: decodeHtml(url),
                label: (typeof t === 'object' && (t.label || t.name || t.lang || t.language)) || 'Subtitle',
                kind: kind && /caption|subtitle|sub/.test(kind) ? kind : 'captions',
                isDefault: !!(typeof t === 'object' && t.default)
            });
        });
    });

    return out;
}

// Read #EXT-X-MEDIA:TYPE=SUBTITLES entries out of an HLS master playlist.
// This is where anidb actually exposes its subtitle tracks.
async function subsFromMasterPlaylist(masterUrl) {
    const out = [];
    try {
        if (!masterUrl) return out;
        const response = await soraFetch(masterUrl);
        if (!response) return out;
        const text = await response.text();
        if (!text || text.indexOf('EXT-X-MEDIA') === -1) return out;

        const seen = {};
        const lineRe = /#EXT-X-MEDIA:([^\n\r]*TYPE=SUBTITLES[^\n\r]*)/gi;
        let m;
        while ((m = lineRe.exec(text)) !== null) {
            const attrs = m[1];
            const uri = extractFirst(attrs, /URI="([^"]+)"/i);
            if (!uri) continue;

            const abs = resolveUrl(masterUrl, decodeHtml(uri));
            if (seen[abs]) continue;
            seen[abs] = true;

            const name = extractFirst(attrs, /NAME="([^"]+)"/i);
            const lang = extractFirst(attrs, /LANGUAGE="([^"]+)"/i);
            const isDefault = /DEFAULT=YES/i.test(attrs);

            out.push({
                url: abs,
                label: cleanText(name || lang || 'Subtitle'),
                kind: 'captions',
                isDefault: isDefault
            });
        }
    } catch (e) {
        console.log('Master playlist subtitle parse error: ' + e);
    }
    return out;
}

// Resolve a possibly-relative playlist URI against the master playlist URL.
function resolveUrl(baseUrl, uri) {
    if (/^https?:\/\//i.test(uri)) return uri;
    const base = String(baseUrl || '');
    if (uri.charAt(0) === '/') {
        const originMatch = base.match(/^(https?:\/\/[^/]+)/i);
        return originMatch ? originMatch[1] + uri : uri;
    }
    const dir = base.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
    return dir + uri;
}

/* EXTERNAL SUBTITLES (OpenSubtitles REST, title-query variant) */

// anidb never links IMDb (only MAL/AniList/AniDB/Kitsu), so the imdbid- path is
// unavailable. OS REST also accepts a free-text title query, which keeps this
// to a single request.
const OS_REST = 'https://rest.opensubtitles.org/search';
const OS_DL = 'https://dl.opensubtitles.org/en/download/filead/';

// Dub audience wants signs/songs (a.k.a. forced / foreign-parts-only) tracks:
// on-screen text and OP/ED lyrics, without full dialogue subtitles running over
// English audio. This inverts the usual "skip forced tracks" rule, which assumes
// a sub audience. Set false to prefer full dialogue instead.
const PREFER_SIGNS_SONGS = true;

// Release-name markers for signs/songs tracks, used when the API's
// SubForeignPartsOnly flag is absent.
// Underscores are word characters to \b, so use explicit separator classes.
// Plural required: track labels use "Signs"/"Songs", whereas singular "Song"
// commonly appears in show titles (e.g. "Song of the Sea").
const SIGNS_SONGS_RE = /(?:^|[^a-z0-9])(s&s|forced|foreign[\s_.\-]*parts|signs|songs)(?:[^a-z0-9]|$)/i;

// Pull slug + episode number back off the href written by extractEpisodes.
function parseEpisodeMeta(url) {
    const s = String(url || '');
    const slug = extractFirst(s, /[?&]t=([^&]+)/);
    const num = extractFirst(s, /[?&]n=(\d+)/);
    const season = extractFirst(s, /[?&]s=(\d+)/);
    return {
        title: slug ? decodeURIComponent(slug) : '',
        season: season ? parseInt(season, 10) : 1,
        episode: num ? parseInt(num, 10) : 0
    };
}

function slugToTitle(slug) {
    return String(slug || '')
        .replace(/-\d+$/, '')                              // trailing anidb id
        .replace(/-(?:season|part|cour)-\d+$/i, '')        // season suffix
        .replace(/-(?:season|part|cour)-[a-z]+$/i, '')     // "-season-two"
        .replace(/-/g, ' ')
        .trim();
}

// anidb slugs carry the season in the name ("attack-on-titan-season-2-459").
function parseSeasonFromSlug(slug) {
    const s = String(slug || '').replace(/-\d+$/, '');
    const num = s.match(/-(?:season|part|cour)-(\d{1,2})$/i);
    if (num) return parseInt(num[1], 10);

    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    const word = s.match(/-(?:season|part|cour)-([a-z]+)$/i);
    if (word && words[word[1].toLowerCase()]) return words[word[1].toLowerCase()];

    return 1;
}

// Single request, English only, no size-measuring downloads (that's the
// expensive part of the reference pipeline and we skip it entirely).
async function fetchExternalSubs(meta) {
    try {
        if (!meta || !meta.title || !meta.episode) return [];

        // OS REST expects '+' between query words, and a season segment.
        const q = meta.title.replace(/[^a-z0-9 ]/gi, ' ').trim().replace(/\s+/g, '+');
        if (!q) return [];
        const url = `${OS_REST}/episode-${meta.episode}/query-${q}/season-${meta.season}/sublanguageid-eng`;

        const response = await soraFetch(url, {
            headers: {
                // Required by OS REST — it rejects requests without it.
                'X-User-Agent': 'trailers.to-UA',
                'Accept': 'application/json',
                // The Sora bridge cannot decompress gzip/brotli.
                'Accept-Encoding': 'identity'
            }
        });
        if (!response) return [];

        // OS REST answers with an HTML error page on a bad/throttled query.
        // Sniff the body first — calling .json() on HTML throws a SyntaxError
        // that the engine surfaces as an [Error] line even when caught.
        let body;
        try { body = await response.text(); } catch (e) { return []; }
        if (!body) return [];
        const trimmed = body.replace(/^\uFEFF/, '').replace(/^\s+/, '');
        if (trimmed.charAt(0) !== '[' && trimmed.charAt(0) !== '{') {
            console.log('[AniDB-DUB] ext subs: non-JSON response, skipping');
            return [];
        }

        let rows;
        try { rows = JSON.parse(trimmed); } catch (e) { return []; }
        if (!Array.isArray(rows) || rows.length === 0) {
            console.log('[AniDB-DUB] ext subs: no rows for s' + meta.season + 'e' + meta.episode + ' "' + meta.title + '"');
            return [];
        }

        const scored = [];
        rows.forEach((row) => {
            if (!row || !row.IDSubtitleFile) return;
            const name = row.SubFileName || '';
            const parsed = parseSubEpisode(name);

            // Episode validation (reference doc §5): a parsed code that
            // disagrees with the request is dropped outright. Unparseable
            // names are allowed but always lose to a verified match.
            // Season is only enforced when the name actually carries one that
            // conflicts — anime releases often omit or renumber seasons.
            let epRank;
            if (parsed && parsed.e === meta.episode && parsed.s === meta.season) epRank = 3; // exact
            else if (parsed && parsed.e === meta.episode) epRank = 2;                        // ep matches
            else if (parsed) return;                                                          // blocked
            else epRank = 1;                                                                  // unknown

            // Signs/songs detection: trust the API flag first, fall back to
            // the release name.
            const flagged = String(row.SubForeignPartsOnly || '') === '1';
            const isSignsSongs = flagged || SIGNS_SONGS_RE.test(name);

            scored.push({
                url: OS_DL + row.IDSubtitleFile,
                label: isSignsSongs ? 'English (Signs & Songs)' : 'English',
                epRank: epRank,
                typeRank: PREFER_SIGNS_SONGS ? (isSignsSongs ? 1 : 0) : (isSignsSongs ? 0 : 1),
                isSignsSongs: isSignsSongs,
                name: name
            });
        });

        if (scored.length === 0) return [];

        // Preferred type outranks everything; correct episode breaks ties.
        scored.sort((a, b) => (b.typeRank - a.typeRank) || (b.epRank - a.epRank));

        const out = [];
        const best = scored[0];
        out.push({ url: best.url, label: best.label, headers: {}, isDefault: true, isSignsSongs: best.isSignsSongs });

        // Also offer the opposite kind as a second pick, so full dialogue stays
        // reachable from the picker if the signs track is sparse (or missing).
        const alt = scored.find((s) => s.isSignsSongs !== best.isSignsSongs);
        if (alt) out.push({ url: alt.url, label: alt.label, headers: {}, isDefault: false, isSignsSongs: alt.isSignsSongs });

        console.log('[AniDB-DUB] ext sub: ' + best.label + ' ep=' + best.epRank + ' ' + best.name + (alt ? ' | alt: ' + alt.label : ' | no alt'));
        return out;
    } catch (e) {
        console.log('External subs error: ' + e);
        return [];
    }
}

// Parse an s:e code out of a release name (reference doc §5).
function parseSubEpisode(name) {
    const n = String(name || '');
    let m = n.match(/\bS(\d{1,2})[.\-_ ]?E(\d{1,3})\b/i); if (m) return { s: +m[1], e: +m[2] };
    m = n.match(/\b(\d{1,2})x(\d{1,3})\b/i);              if (m) return { s: +m[1], e: +m[2] };
    m = n.match(/\[(\d{1,2})\.(\d{1,3})\]/);              if (m) return { s: +m[1], e: +m[2] };
    m = n.match(/(?:^|[\s\-_.])(\d)(\d{2})(?:[\s\-_.]|$)/); if (m) return { s: +m[1], e: +m[2] };
    return null;
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
// Precedence mirrors AnimexOne: explicit default -> English -> first available.
function pickPrimarySub(list) {
    if (!list || list.length === 0) return null;
    return list.find((s) => s.isDefault)
        || list.find((s) => /^en$/i.test(s.label) || /eng/i.test(s.label))
        || list[0];
}

function prettifyLangLabel(lang) {
    return STREAM_LABEL;
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

// anidb.app anime URLs are /anime/<slug>-<numericId>. Return the slug portion.
function parseAnimeSlug(url) {
    const m = String(url || '').match(/\/anime\/([^/?#]+)/i);
    return m && m[1] ? m[1] : '';
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

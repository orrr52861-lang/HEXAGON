const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const SEARCH_TIMEOUT_MS = 12000;
const PAGE_TIMEOUT_MS = 7000;
const MAX_PAGES = 6;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return send(res, 400, { error: 'Введите запрос.' });
    if (query.length > 300) return send(res, 400, { error: 'Запрос слишком длинный.' });

    try {
      const results = await searchWeb(query);
      if (!results.length) {
        return send(res, 200, {
          answer: 'По этому запросу не удалось найти подходящие материалы. Попробуйте изменить формулировку.',
          sources: [], extractedCount: 0, sourceCount: 0
        });
      }

      // Read a limited number of public result pages in parallel.
      const pages = await Promise.all(results.slice(0, MAX_PAGES).map(readPage));
      const useful = pages.filter(Boolean);
      const answerParts = buildAnswer(query, results, useful);

      return send(res, 200, {
        answer: answerParts.length
          ? answerParts.join('\n\n')
          : 'Поиск нашёл страницы, но не смог получить достаточно текста с них. Некоторые сайты запрещают автоматическое чтение. Источники для проверки приведены ниже.',
        sources: results.slice(0, 8).map((item, i) => ({
          title: item.title,
          url: item.url,
          host: hostname(item.url),
          excerpt: (useful.find(page => page.url === item.url)?.excerpt || item.content || '').slice(0, 260)
        })),
        extractedCount: useful.length,
        sourceCount: results.length,
        note: useful.length
          ? 'Ответ собран из доступных фрагментов найденных страниц. Проверяйте важные сведения по источникам.'
          : 'Автоматическое чтение страниц было ограничено поисковыми источниками.'
      });
    } catch (error) {
      return send(res, 502, { error: error.message || 'Не удалось получить информацию из интернета.' });
    }
  }

  const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const full = path.join(__dirname, file);
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(full).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

async function searchWeb(query) {
  const endpoint = new URL('https://html.duckduckgo.com/html/');
  endpoint.searchParams.set('q', query);
  const response = await fetch(endpoint, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; HEXAGONSearch/1.0)'
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Поисковый источник ответил HTTP ${response.status}. Попробуйте позже.`);
  const html = await response.text();
  if (/anomaly-modal|captcha/i.test(html) && !/result__a/.test(html)) {
    throw new Error('Поисковый источник временно ограничил запросы. Попробуйте позже.');
  }
  return parseResults(html).slice(0, 12);
}

async function readPage(item) {
  try {
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) return null;

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; HEXAGONSearch/1.0)'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null;

    const html = (await response.text()).slice(0, 1_500_000);
    const text = cleanPage(html);
    if (text.length < 180) return null;
    return { url: item.url, title: item.title, text, excerpt: text.slice(0, 900) };
  } catch {
    return null;
  }
}

function buildAnswer(query, results, pages) {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2);
  const candidates = [];

  for (const page of pages) {
    const sentences = splitSentences(page.text);
    const ranked = sentences.map(sentence => {
      const lower = sentence.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 2 : 0), 0)
        + Math.min(sentence.length / 160, 1);
      return { sentence, score };
    }).filter(x => x.sentence.length >= 45 && x.sentence.length <= 360)
      .sort((a, b) => b.score - a.score);

    const chosen = [];
    for (const item of ranked) {
      if (chosen.length >= 2) break;
      if (!chosen.some(old => similarity(old, item.sentence) > 0.72)) chosen.push(item.sentence);
    }
    if (chosen.length) candidates.push({ url: page.url, title: page.title, sentences: chosen });
  }

  // Use short search snippets as a fallback when a site blocks page reading.
  if (!candidates.length) {
    for (const item of results.slice(0, 5)) {
      const snippet = (item.content || '').trim();
      if (snippet.length > 35) candidates.push({ url: item.url, title: item.title, sentences: [snippet.slice(0, 280)] });
    }
  }

  return candidates.slice(0, 5).map((item, index) => {
    const text = item.sentences.join(' ');
    return `${text}`;
  });
}

function parseResults(html) {
  const blocks = html.match(/<div class="result[^"]*"[\s\S]*?(?=<div class="result[^"]*"|<\/body>)/g) || [];
  const out = [];
  const seen = new Set();
  for (const block of blocks) {
    const match = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!match) continue;
    let href = decode(match[1]);
    try {
      const parsed = new URL(href, 'https://html.duckduckgo.com');
      href = parsed.searchParams.get('uddg') || href;
    } catch {}
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/td>/i);
    out.push({
      title: strip(match[2]) || hostname(href),
      url: href,
      content: snippetMatch ? strip(snippetMatch[1] || snippetMatch[2]) : ''
    });
  }
  return out;
}

function cleanPage(html) {
  let value = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|button|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/article|\/section|\/li|\/h[1-6])\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, ' ');
  return decode(value).replace(/\s+/g, ' ').replace(/(\. ){2,}/g, '. ').trim();
}
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[А-ЯA-ZЁ0-9])/u).map(s => s.trim()).filter(Boolean);
}
function similarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...wordsA].filter(word => wordsB.has(word)).length;
  return intersection / Math.max(1, Math.min(wordsA.size, wordsB.size));
}
function strip(value) { return decode(String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()); }
function decode(value) {
  return String(value)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

server.listen(PORT, '0.0.0.0', () => console.log(`HEXAGON Search запущен на порту ${PORT}`));

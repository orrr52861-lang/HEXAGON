const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
// Можно задать свой совместимый SearXNG через переменную SEARXNG_URL.
const ENGINES = (process.env.SEARXNG_URL
  ? [process.env.SEARXNG_URL]
  : ['https://searx.be', 'https://search.sapti.me', 'https://searx.tiekoetter.com']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    const category = url.searchParams.get('category') || 'general';
    if (!query) return send(res, 400, { error: 'Введите поисковый запрос.' });
    if (query.length > 300) return send(res, 400, { error: 'Запрос слишком длинный.' });
    const allowed = ['general', 'images', 'videos', 'news'];
    if (!allowed.includes(category)) return send(res, 400, { error: 'Неизвестная категория.' });

    let lastError = 'Поисковые серверы временно недоступны.';
    for (const engine of ENGINES) {
      try {
        const endpoint = new URL('/search', engine);
        endpoint.searchParams.set('q', query);
        endpoint.searchParams.set('format', 'json');
        endpoint.searchParams.set('language', 'all');
        endpoint.searchParams.set('safesearch', '1');
        endpoint.searchParams.set('categories', category);
        const response = await fetch(endpoint, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'HEXAGON-Search/1.0' },
          signal: AbortSignal.timeout(9000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.results)) throw new Error('Источник не вернул JSON-результаты');
        const results = payload.results.slice(0, 30).map(item => ({
          title: item.title || '',
          url: item.url || '',
          pretty_url: item.pretty_url || '',
          content: item.content || '',
          img_src: item.img_src || '',
          thumbnail: item.thumbnail || '',
          publishedDate: item.publishedDate || ''
        })).filter(item => item.title && /^https?:\/\//i.test(item.url));
        return send(res, 200, { results, source: new URL(engine).hostname });
      } catch (err) {
        lastError = err.message;
      }
    }
    return send(res, 502, { error: `${lastError}. Попробуйте позже или настройте свой SearXNG-сервер.` });
  }

  const filePath = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const fullPath = path.join(__dirname, filePath);
  if (!fullPath.startsWith(__dirname)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(fullPath, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const type = fullPath.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});
function send(res, code, body, type='application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
server.listen(PORT, () => console.log(`HEXAGON Search запущен: http://localhost:${PORT}`));

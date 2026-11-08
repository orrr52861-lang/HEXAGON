
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return send(res, 400, {error:'Введите запрос.'});
    if (query.length > 300) return send(res, 400, {error:'Запрос слишком длинный.'});
    try {
      // HEXAGON fetches the search page server-side and displays parsed results locally.
      const endpoint = new URL('https://html.duckduckgo.com/html/');
      endpoint.searchParams.set('q', query);
      const response = await fetch(endpoint, {
        headers: {
          'Accept':'text/html,application/xhtml+xml',
          'Accept-Language':'ru-RU,ru;q=0.9,en;q=0.8',
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error(`Поисковый источник ответил HTTP ${response.status}. Попробуйте позже.`);
      const html = await response.text();
      if (/anomaly-modal|captcha/i.test(html) && !/result__a/.test(html))
        throw new Error('Поисковый источник временно ограничил запросы. Попробуйте позже.');
      const results = parseResults(html).slice(0,20);
      if (!results.length) throw new Error('Источник не вернул результаты. Попробуйте позже.');
      return send(res,200,{results,source:'DuckDuckGo через сервер HEXAGON'});
    } catch (e) {
      return send(res,502,{error:e.message || 'Не удалось получить результаты.'});
    }
  }
  const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const full = path.join(__dirname,file);
  fs.readFile(full,(err,data)=>{
    if(err) return send(res,404,'Not found','text/plain');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});
    res.end(data);
  });
});

function parseResults(html) {
  const blocks = html.match(/<div class="result[^"]*"[\s\S]*?(?=<div class="result[^"]*"|<\/body>)/g) || [];
  const out=[];
  for (const block of blocks) {
    const m=block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!m) continue;
    let href=decode(m[1]);
    try { const u=new URL(href,'https://html.duckduckgo.com'); href=u.searchParams.get('uddg')||href; } catch {}
    if(!/^https?:\/\//i.test(href)) continue;
    const sm=block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/td>/i);
    const um=block.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({title:strip(m[2]),url:href,pretty_url:um?strip(um[1]):new URL(href).hostname,content:sm?strip(sm[1]||sm[2]):''});
  }
  return out;
}
function strip(s){return decode(String(s).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());}
function decode(s){return String(s).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));}
function send(res,code,body,type='application/json; charset=utf-8'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(body):body);}
server.listen(PORT,'0.0.0.0',()=>console.log(`HEXAGON Search запущен на порту ${PORT}`));

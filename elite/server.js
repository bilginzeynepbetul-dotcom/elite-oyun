// Elite Manager - basit statik dosya sunucusu
// Hiçbir npm paketine ihtiyaç duymaz (sadece Node.js'in kendi 'http' ve 'fs' modülleri).
// Bu yüzden "npm install" ATLANABİLİR - doğrudan "node server.js" ile çalışır.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Path traversal koruması (../ ile klasör dışına çıkmayı engeller)
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('403 Yasak');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 - Dosya bulunamadı: ' + urlPath);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 - Sunucu hatası: ' + err.message);
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('==================================================');
  console.log('  Elite Manager sunucusu çalışıyor!');
  console.log('  Tarayıcıda şu adresi aç:  http://localhost:' + PORT);
  console.log('  Durdurmak için: Ctrl + C');
  console.log('==================================================');
});

const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        mensaje: 'Servidor simple AMA Orquestador OK',
        port: PORT,
        url: req.url,
      })
    );
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', url: req.url }));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP simple escuchando en puerto ${PORT}`);
});

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mensaje: 'Servidor simple AMA Orquestador OK',
    port: PORT,
    url: req.url,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor simple escuchando en puerto ${PORT}`);
});

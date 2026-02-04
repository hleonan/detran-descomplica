import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import apiRouter from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Body JSON
app.use(express.json({ limit: '2mb' }));

// Servir arquivos estáticos (sua interface)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rotas da API
app.use('/api', apiRouter);

// Healthcheck (útil pra Cloud Run)
app.get('/health', (req, res) => res.status(200).send('ok'));

// Se cair em qualquer rota não encontrada, manda o index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

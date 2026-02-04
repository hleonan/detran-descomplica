// src/server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import apiRouter from './rotas/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Cloud Run usa PORT. Se não existir, cai no 8080.
const PORT = process.env.PORT || 8080;

// Body JSON (pra POST com JSON)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ✅ Healthcheck
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ✅ Rotas da API
app.use('/api', apiRouter);

// ✅ Servir arquivos estáticos do /public
// src/server.js -> volta 1 nível -> /public
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// ✅ Raiz abre o index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ✅ Fallback: qualquer rota desconhecida vira 404 (não quebra o serviço)
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// ✅ Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

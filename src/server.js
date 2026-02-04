import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import apiRouter from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

// Site (frontend)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API
app.use('/api', apiRouter);

// Healthcheck
app.get('/health', (req, res) => res.status(200).send('ok'));

// Home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

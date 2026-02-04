import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// JSON para as rotas /api
app.use(express.json({ limit: '2mb' }));

// Serve sua interface (pasta "público")
app.use(express.static(path.join(__dirname, '..', 'público')));

// Página principal = index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'público', 'index.html'));
});

// Health
app.get('/health', (req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import apiRouter from "./rotas/api.js"; // <-- ajuste se seu api.js estiver em outro lugar

const app = express();

// Cloud Run injeta PORT. Se você não usar isso, dá erro.
const PORT = Number(process.env.PORT || 8080);

// Para resolver __dirname no ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Pasta pública (tem que ser "public" sem acento)
const publicDir = path.join(__dirname, "..", "public");

// Middlewares básicos
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => res.status(200).send("OK"));

// API Router
app.use("/api", apiRouter);

// Static
app.use(express.static(publicDir));

// Home sempre entrega o index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// (Opcional) fallback pra rotas inexistentes (evita "Not Found" em navegação)
app.use((req, res) => {
  // se pedir algo que não existe, volta pro index
  res.status(200).sendFile(path.join(publicDir, "index.html"));
});

// Sobe server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server ON: http://0.0.0.0:${PORT}`);
  console.log(`✅ publicDir: ${publicDir}`);
});

// src/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import apiRouter from "./routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Cloud Run injeta PORT (geralmente 8080)
const PORT = process.env.PORT || 8080;

// JSON para rotas /api
app.use(express.json({ limit: "2mb" }));

// ✅ Pasta certa do front
// Estrutura: /public/index.html e /public/assets/logo.png
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// ✅ API
app.use("/api", apiRouter);

// ✅ Health (root)
app.get("/health", (req, res) => res.status(200).send("ok"));

// ✅ Fallback: se não achou rota/arquivo, devolve o index.html (SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

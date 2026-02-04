// src/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// Cloud Run usa PORT. Se não existir, cai no 8080.
const PORT = process.env.PORT || 8080;

// Logs de erro que normalmente derrubam o container
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ Healthcheck
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ✅ Public (sempre tenta servir a UI)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ✅ API: tenta carregar o router real.
// Se quebrar, NÃO derruba o servidor — responde "em construção".
async function mountApiSafely() {
  try {
    const mod = await import("./rotas/api.js");
    const apiRouter = mod.default;

    app.use("/api", apiRouter);
    console.log("✅ /api carregado com sucesso");
  } catch (err) {
    console.error("❌ Falha ao carregar ./rotas/api.js. Subindo /api em modo stub.");
    console.error(err);

    const stub = express.Router();
    stub.all("*", (req, res) => {
      res.status(503).json({
        ok: false,
        stub: true,
        error: "API em construção (api.js com erro ou não encontrado).",
        details: String(err?.message || err),
      });
    });

    app.use("/api", stub);
  }
}

// ✅ Start sempre acontece (Cloud Run precisa disso)
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await mountApiSafely();
});

// ✅ 404 padrão
app.use((req, res) => {
  res.status(404).send("Not Found");
});

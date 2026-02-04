// src/server.js
const express = require("express");
const path = require("path");

const apiRouter = require("./routes/api");

const app = express();

// Cloud Run usa PORT (geralmente 8080)
const PORT = process.env.PORT || 8080;

// JSON e forms
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ API sempre antes do static
app.use("/api", apiRouter);

// ✅ Servir a pasta public no ROOT do site
// Ex.: public/assets/logo.png -> https://seusite.com/assets/logo.png
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// ✅ Healthcheck
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ✅ Fallback: qualquer rota que não for /api cai no index.html
app.get("*", (req, res) => {
  // não intercepta rotas de API
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server rodando na porta ${PORT}`);
});

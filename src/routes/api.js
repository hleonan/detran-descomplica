// src/routes/api.js
import express from "express";
import { get2CaptchaBalance } from "../services/twocaptcha.js";

const router = express.Router();

// Health da API
router.get("/health", (req, res) => res.json({ ok: true }));

// Saldo 2Captcha
router.get("/saldo", async (req, res) => {
  try {
    const apiKey = process.env.TWOCAPTCHA_API_KEY;

    // Sem key: não quebra UI
    if (!apiKey) {
      return res.status(200).json({
        saldo: "0.00",
        error: "TWOCAPTCHA_API_KEY não configurada",
        stub: true,
      });
    }

    const saldo = await get2CaptchaBalance(apiKey);
    return res.json({ saldo: String(saldo), stub: false });
  } catch (err) {
    console.error("Erro /api/saldo:", err);
    return res.status(200).json({
      saldo: "0.00",
      error: err?.message || "Erro ao consultar saldo",
      stub: true,
    });
  }
});

// Stub: pontuação (não derruba UI)
router.get("/pontuacao", async (req, res) => {
  return res.json({
    ok: true,
    stub: true,
    msg: "Em construção: consulta de pontuação/multas",
  });
});

export default router;

// src/routes/api.js
import express from "express";
import { get2CaptchaBalance } from "../services/twocaptcha.js";
import { emitirCertidaoPDF } from "../services/certidao.js";

const router = express.Router();

// Health da API
router.get("/health", (req, res) => res.json({ ok: true }));

// Saldo 2Captcha
router.get("/saldo", async (req, res) => {
  try {
    const apiKey = process.env.TWOCAPTCHA_API_KEY;

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

// ✅ CERTIDÃO: retorna PDF
router.post("/certidao", async (req, res) => {
  try {
    const { cpf, cnh } = req.body || {};

    const pdfBuffer = await emitirCertidaoPDF({ cpf, cnh });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="certidao.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("Erro /api/certidao:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Erro ao emitir certidão",
    });
  }
});

// Stub: pontuação
router.get("/pontuacao", async (req, res) => {
  return res.json({
    ok: true,
    stub: true,
    msg: "Em construção: consulta de pontuação/multas",
  });
});

export default router;

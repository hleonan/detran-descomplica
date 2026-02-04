import express from "express";

const router = express.Router();

/**
 * GET /api/saldo
 * Consulta saldo do 2captcha.
 */
router.get("/saldo", async (req, res) => {
  try {
    const key = process.env.TWOCAPTCHA_API_KEY;

    if (!key) {
      return res.status(500).json({
        saldo: "0.00",
        error: "TWOCAPTCHA_API_KEY não configurada",
        stub: false,
      });
    }

    const url = `https://2captcha.com/res.php?key=${encodeURIComponent(
      key
    )}&action=getbalance&json=1`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (!data || data.status !== 1) {
      return res.status(500).json({
        saldo: "0.00",
        error: data?.request || "Erro 2Captcha",
        stub: false,
      });
    }

    return res.json({ saldo: data.request, stub: false });
  } catch (err) {
    return res.status(500).json({
      saldo: "0.00",
      error: err?.message || "Erro inesperado",
      stub: false,
    });
  }
});

/**
 * POST /api/certidao
 * Stub: ainda não implementa automação.
 */
router.post("/certidao", async (req, res) => {
  const { cpf, cnh } = req.body || {};

  if (!cpf || !cnh) {
    return res.status(400).json({
      sucesso: false,
      erro: "CPF e CNH são obrigatórios",
      stub: true,
    });
  }

  return res.json({
    sucesso: false,
    erro: "Em construção: emissão automática ainda não implementada",
    stub: true,
  });
});

export default router;

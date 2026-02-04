import express from 'express';

const router = express.Router();

// ✅ Saldo 2Captcha
router.get('/saldo', async (req, res) => {
  try {
    const key = process.env.TWOCAPTCHA_API_KEY;
    if (!key) {
      return res.status(500).json({ saldo: "0.00", erro: "TWOCAPTCHA_API_KEY não configurada", stub: false });
    }

    const url = `https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=getbalance&json=1`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data || data.status !== 1) {
      return res.status(500).json({ saldo: "0.00", erro: data?.request || "Erro 2Captcha", stub: false });
    }

    return res.json({ saldo: data.request, stub: false });
  } catch (err) {
    return res.status(500).json({ saldo: "0.00", erro: err.message, stub: false });
  }
});

// ✅ Certidão (stub)
router.post('/certidao', async (req, res) => {
  const { cpf, cnh } = req.body || {};
  if (!cpf || !cnh) {
    return res.status(400).json({ sucesso: false, erro: 'CPF e CNH são obrigatórios', stub: true });
  }

  // Não quebra UI: responde “ok” mas avisa que é stub
  return res.json({
    sucesso: true,
    arquivo: null,
    mensagem: 'Em construção: emissão automática ainda não implementada',
    stub: true
  });
});

// ✅ Pontuação (stub) — SUA UI CHAMA POST /api/pontuacao
router.post('/pontuacao', async (req, res) => {
  const { cpf, cnh, uf } = req.body || {};
  if (!cpf) {
    return res.status(400).json({ sucesso: false, erro: 'CPF é obrigatório', stub: true });
  }

  // Não quebra UI: devolve o “shape” que o front espera
  return res.json({
    sucesso: true,
    resumo: {
      pontosTotais: 0,
      multasPendentes: 0,
      situacao: `EM CONSTRUÇÃO (stub) - UF ${uf || 'RJ'}`
    },
    multas: [],
    stub: true
  });
});

// ✅ OCR CNH (stub)
router.post('/ocr/cnh', async (req, res) => {
  return res.json({
    sucesso: true,
    dados: { cpf: null, cnh: null, nome: null },
    confianca: 0,
    mensagem: 'Em construção: OCR ainda não implementado',
    stub: true
  });
});

// ✅ Fluxo completo (stub)
router.post('/fluxo-completo', async (req, res) => {
  return res.json({
    sucesso: true,
    dadosExtraidos: { cpf: null, cnh: null },
    confiancaOCR: 0,
    certidao: { arquivo: null },
    mensagem: 'Em construção: fluxo completo ainda não implementado',
    stub: true
  });
});

export default router;

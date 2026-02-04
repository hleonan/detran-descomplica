import express from 'express';

const router = express.Router();

// ✅ Saldo 2Captcha (stub por enquanto)
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
    return res.status(400).json({ sucesso: false, erro: 'CPF e CNH são obrigatórios' });
  }

  return res.json({
    sucesso: false,
    erro: 'Em construção: emissão automática ainda não implementada',
    stub: true
  });
});

// ✅ Pontuação (stub)
rrouter.get('/pontuacao', (req, res) => {
  res.json({
    sucesso: false,
    erro: 'Em construção: use POST /api/pontuacao (via interface)',
    stub: true
  });
});

// ✅ OCR CNH (stub)
router.post('/ocr/cnh', async (req, res) => {
  return res.json({
    sucesso: false,
    erro: 'Em construção: OCR ainda não implementado',
    stub: true
  });
});

// ✅ Fluxo completo (stub)
router.post('/fluxo-completo', async (req, res) => {
  return res.json({
    sucesso: false,
    erro: 'Em construção: fluxo completo ainda não implementado',
    stub: true
  });
});

export default router;

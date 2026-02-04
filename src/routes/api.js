// src/rotas/api.js
import express from 'express';

const router = express.Router();

// ✅ saldo (stub seguro)
router.get('/saldo', async (req, res) => {
  try {
    const key = process.env.TWOCAPTCHA_API_KEY;
    if (!key) return res.json({ saldo: '0.00', stub: true, erro: 'TWOCAPTCHA_API_KEY não configurada' });

    const url = `https://2captcha.com/res.php?key=${key}&action=getbalance&json=1`;
    const r = await fetch(url);
    const data = await r.json();

    if (data.status === 1) return res.json({ saldo: String(data.request), stub: false });
    return res.json({ saldo: '0.00', stub: false, erro: data.request || 'Erro 2captcha' });
  } catch (e) {
    return res.json({ saldo: '0.00', stub: true, erro: e.message });
  }
});

// ✅ STUBS (não quebram a UI)
router.post('/certidao', (req, res) => {
  res.json({ sucesso: false, stub: true, erro: 'Em construção: certidão' });
});

router.post('/pontuacao', (req, res) => {
  res.json({ sucesso: false, stub: true, erro: 'Em construção: pontuação/multas' });
});

router.post('/ocr/cnh', (req, res) => {
  res.json({ sucesso: false, stub: true, erro: 'Em construção: OCR CNH' });
});

router.post('/fluxo-completo', (req, res) => {
  res.json({ sucesso: false, stub: true, erro: 'Em construção: fluxo completo' });
});

export default router;

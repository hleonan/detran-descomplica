import express from 'express';

const router = express.Router();

// ✅ Saldo 2Captcha (stub por enquanto)
router.get('/saldo', async (req, res) => {
  // Se você quiser, depois a gente liga no 2Captcha de verdade.
  res.json({ saldo: "0.00", stub: true });
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
router.post('/pontuacao', async (req, res) => {
  const { cpf, cnh } = req.body || {};
  if (!cpf || !cnh) {
    return res.status(400).json({ sucesso: false, erro: 'CPF e CNH são obrigatórios' });
  }

  // Retorno fake (mas no formato que sua UI já sabe renderizar)
  return res.json({
    sucesso: true,
    stub: true,
    resumo: {
      pontosTotais: 0,
      multasPendentes: 0,
      situacao: 'Sem dados (stub)'
    },
    multas: []
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

import express from 'express';
import multer from 'multer';

import { get2CaptchaBalance } from '../services/twocaptcha.js';
import { emitirCertidaoStub } from '../services/certidao.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ✅ saldo 2captcha (front chama /api/saldo)
router.get('/saldo', async (req, res) => {
  try {
    const saldo = await get2CaptchaBalance();
    res.json({ saldo });
  } catch (err) {
    res.status(500).json({ saldo: 0, erro: err.message });
  }
});

// ✅ certidão (front chama /api/certidao)
router.post('/certidao', async (req, res) => {
  try {
    const { cpf, cnh } = req.body || {};
    if (!cpf || !cnh) {
      return res.status(400).json({ sucesso: false, erro: 'CPF e CNH são obrigatórios' });
    }

    // Por enquanto é “stub” (base pronta)
    const result = await emitirCertidaoStub({ cpf, cnh });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// ✅ pontuação (placeholder por enquanto)
router.post('/pontuacao', async (req, res) => {
  return res.json({
    sucesso: false,
    erro: 'Em construção: endpoint /api/pontuacao ainda não implementado no backend'
  });
});

// ✅ OCR CNH (placeholder por enquanto)
router.post('/ocr/cnh', upload.single('cnh'), async (req, res) => {
  return res.json({
    sucesso: false,
    erro: 'Em construção: OCR ainda não implementado no backend'
  });
});

// ✅ fluxo completo (placeholder por enquanto)
router.post('/fluxo-completo', upload.single('cnh'), async (req, res) => {
  return res.json({
    sucesso: false,
    erro: 'Em construção: fluxo completo ainda não implementado no backend'
  });
});

export default router;

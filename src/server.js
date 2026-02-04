import express from "express";

const router = express.Router();

function stub(res, extra = {}) {
  return res.json({
    sucesso: false,
    stub: true,
    mensagem: "Em construção",
    ...extra,
  });
}

// Saldo 2Captcha (se tiver TWOCAPTCHA_API_KEY, retorna placeholder)
// Depois a gente implementa de verdade.
router.get("/saldo", async (req, res) => {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;

  if (!apiKey) {
    return res.json({ saldo: "0.00", stub: true, erro: "TWOCAPTCHA_API_KEY não configurada" });
  }

  // STUB: só confirma que a chave existe
  return res.json({ saldo: "OK", stub: true });
});

// Certidão (STUB)
router.post("/certidao", async (req, res) => {
  const { cpf, cnh } = req.body || {};
  if (!cpf || !cnh) return stub(res, { erro: "CPF e CNH são obrigatórios" });

  // STUB: devolve um "arquivo" fake só pra UI não quebrar
  return res.json({
    sucesso: true,
    stub: true,
    arquivo: "/exemplos/certidao-exemplo.pdf",
  });
});

// Pontuação (STUB)
router.post("/pontuacao", async (req, res) => {
  const { cpf, cnh, uf } = req.body || {};
  if (!cpf || !cnh) return stub(res, { erro: "CPF e CNH são obrigatórios" });

  return res.json({
    sucesso: true,
    stub: true,
    resumo: {
      pontosTotais: 0,
      multasPendentes: 0,
      situacao: "SEM DADOS (stub)",
      uf: uf || "RJ",
    },
    multas: [],
  });
});

// OCR CNH (STUB)
router.post("/ocr/cnh", async (req, res) => {
  return res.json({
    sucesso: true,
    stub: true,
    confianca: 0,
    dados: { cpf: null, cnh: null, nome: null },
  });
});

// Fluxo completo (STUB)
router.post("/fluxo-completo", async (req, res) => {
  return res.json({
    sucesso: true,
    stub: true,
    dadosExtraidos: { cpf: "000.000.000-00", cnh: "000000000000000" },
    confiancaOCR: 0,
    certidao: { arquivo: "/exemplos/certidao-exemplo.pdf" },
  });
});

export default router;

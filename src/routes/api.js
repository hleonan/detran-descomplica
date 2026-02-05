// src/routes/api.js
import multer from "multer";
import fs from "fs";
import path from "path";
import OCRExtractor from "../ocrExtractor.mjs";
import express from "express";
import { get2CaptchaBalance } from "../services/twocaptcha.js";
import { emitirCertidaoPDF } from "../services/certidao.js";
import { extractCertidaoTextFromBuffer } from "../certidaoParser.js";
import { classificarCertidao } from "../certidaoClassifier.js";
import PontuacaoAutomation from "../pontuacaoAutomation.mjs";

const router = express.Router();
// Upload em memória (Cloud Run-friendly)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype);
    if (!ok) return cb(new Error("Tipo inválido. Envie PDF, JPG ou PNG."));
    cb(null, true);
  }
});

// OCR CNH (Imagem -> Vision)
// OBS: PDF vai ser aceito no upload, mas OCR de PDF é outro fluxo (vou te explicar já já)
router.post("/ocr-cnh", upload.single("doc"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

    // Aqui, do jeito simples e confiável: OCR só pra imagem
    if (req.file.mimetype === "application/pdf") {
      return res.status(400).json({
        error: "PDF recebido. OCR de PDF precisa de fluxo assíncrono com Google Cloud Storage. Por enquanto, envie foto (JPG/PNG)."
      });
    }

    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GOOGLE_VISION_API_KEY não configurada no servidor." });
    }

    // Salva temporário em /tmp
    const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
    const tmpPath = path.join("/tmp", `cnh_upload_${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    const ocr = new OCRExtractor(apiKey);
    const result = await ocr.extrairDadosCNH(tmpPath);

    // limpa
    try { fs.unlinkSync(tmpPath); } catch {}

    if (!result?.sucesso) {
      return res.status(422).json({ error: result?.erro || "Não consegui extrair os dados." });
    }

    return res.json({
      cpf: result?.dados?.cpf || null,
      cnh: result?.dados?.cnh || null,
      nome: result?.dados?.nome || null,
      confianca: result?.confianca ?? null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Erro interno no OCR." });
  }
});

/**
 * "Banco" em memória (MVP)
 * - Cloud Run pode reiniciar e isso zera
 * - Serve pra validar o fluxo agora
 */
const certidaoStore = new Map(); // caseId -> { pdfBuffer, createdAt, analysis }
const TTL_MS = 15 * 60 * 1000; // 15 min

function cleanupStore() {
  const now = Date.now();
  for (const [caseId, item] of certidaoStore.entries()) {
    if (!item?.createdAt || now - item.createdAt > TTL_MS) {
      certidaoStore.delete(caseId);
    }
  }
}

function newCaseId() {
  return `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

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

/**
 * ✅ PRIORIDADE 1 - TELA 2
 * POST /api/consultar-certidao
 * Entrada: { cpf, cnh }
 * Saída: { ok, caseId, temProblemas, status, motivo, flags }
 */
router.post("/consultar-certidao", async (req, res) => {
  try {
    cleanupStore();

    const { cpf, cnh } = req.body || {};
    if (!cpf || !cnh) {
      return res.status(400).json({ ok: false, error: "Informe cpf e cnh" });
    }

    // 1) Gera PDF (automação)
    const pdfBuffer = await emitirCertidaoPDF({ cpf, cnh });

    // 2) Extrai texto do PDF e classifica
    const { normalizedText } = await extractCertidaoTextFromBuffer(pdfBuffer);
    const analysis = classificarCertidao(normalizedText);

    const temProblemas = analysis.status === "RESTRICAO";

    // 3) Guarda o PDF (MVP em memória)
    const caseId = newCaseId();
    certidaoStore.set(caseId, {
      pdfBuffer,
      createdAt: Date.now(),
      analysis,
    });

    return res.json({
      ok: true,
      caseId,
      temProblemas,
      status: analysis.status,
      motivo: analysis.motivo,
      flags: analysis.flags,
      ttlMinutos: Math.floor(TTL_MS / 60000),
    });
  } catch (err) {
    console.error("Erro /api/consultar-certidao:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Erro ao consultar certidão",
    });
  }
});

/**
 * ✅ TELA 4 - Emitir Certidão do PDF já guardado
 * GET /api/certidao/:caseId  -> devolve PDF
 */
router.get("/certidao/:caseId", async (req, res) => {
  try {
    cleanupStore();

    const { caseId } = req.params;
    const item = certidaoStore.get(caseId);

    if (!item?.pdfBuffer) {
      return res.status(404).json({
        ok: false,
        error: "Certidão não encontrada (expirou ou o servidor reiniciou).",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="certidao.pdf"');
    return res.status(200).send(item.pdfBuffer);
  } catch (err) {
    console.error("Erro /api/certidao/:caseId:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Erro" });
  }
});

// (Opcional) Mantém sua rota antiga que gera e devolve na hora (pode apagar depois)
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

/**
 * ✅ PRIORIDADE 2 - TELA 4
 * POST /api/consultar-multas
 * Entrada: { cpf, cnh }
 * Saída: { ok, multas, resumo, dataConsulta }
 */
router.post("/consultar-multas", async (req, res) => {
  try {
    const { cpf, cnh } = req.body || {};
    if (!cpf || !cnh) {
      return res.status(400).json({ ok: false, error: "Informe cpf e cnh" });
    }

    const apiKey = process.env.TWOCAPTCHA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: "Serviço temporariamente indisponível (CAPTCHA não configurado)",
      });
    }

    // Instancia automação
    const automation = new PontuacaoAutomation(apiKey);
    
    // Executa consulta
    const resultado = await automation.consultarPontuacao(cpf, cnh, "RJ");

    if (!resultado.sucesso) {
      return res.status(400).json({
        ok: false,
        error: resultado.erro || "Erro ao consultar multas",
      });
    }

    return res.json({
      ok: true,
      multas: resultado.multas || [],
      resumo: resultado.resumo || {},
      dataConsulta: resultado.dataConsulta,
    });
  } catch (err) {
    console.error("Erro /api/consultar-multas:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Erro ao consultar multas",
    });
  }
});

// Stub: pontuação (manter para compatibilidade)
router.get("/pontuacao", async (req, res) => {
  return res.json({
    ok: true,
    stub: true,
    msg: "Em construção: consulta de pontuação/multas",
  });
});

export default router;

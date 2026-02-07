// src/routes/api.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import { Storage } from "@google-cloud/storage";
import vision from "@google-cloud/vision";

import OCRExtractor from "../ocrExtractor.mjs";
import { get2CaptchaBalance } from "../services/twocaptcha.js";
import { emitirCertidaoPDF } from "../services/certidao_v3.js";
import { extractCertidaoTextFromBuffer } from "../certidaoParser.js";
import { classificarCertidao } from "../certidaoClassifier.js";
import PontuacaoAutomation from "../pontuacaoAutomation.mjs";

const router = express.Router();

// =========================
// Upload em memória (Cloud Run-friendly)
// =========================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
  fileFilter: (req, file, cb) => {
    const ok = ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype);
    if (!ok) return cb(new Error("Tipo inválido. Envie PDF, JPG ou PNG."));
    cb(null, true);
  },
});

// =========================
// OCR PDF (Vision async + GCS) - "banco" em memória (MVP)
// =========================
const storage = new Storage();
const visionClient = new vision.v1.ImageAnnotatorClient();

const ocrJobStore = new Map(); // jobId -> { status, createdAt, error, result: {cpf,cnh,nome,text}, gcsInUri, gcsOutPrefix }
const OCR_TTL_MS = 20 * 60 * 1000; // 20 min

function cleanupOCRJobs() {
  const now = Date.now();
  for (const [jobId, job] of ocrJobStore.entries()) {
    if (!job?.createdAt || now - job.createdAt > OCR_TTL_MS) ocrJobStore.delete(jobId);
  }
}

function newJobId() {
  return `ocr_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function extractCPF(text = "") {
  const m = text.match(/\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/);
  if (!m) return null;
  return m[1].replace(/\D/g, "").replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

function extractCNH(text = "") {
  // CNH costuma ser 11 dígitos; pega o primeiro "bem formado"
  const digits = text.replace(/\D/g, "");
  // tenta achar sequências de 11 no texto original
  const m = text.match(/\b(\d{11})\b/);
  if (m) return m[1];
  // fallback: varre o texto "só dígitos"
  if (digits.length >= 11) return digits.slice(0, 11);
  return null;
}

function extractNome(text = "") {
  // Heurística simples (melhorar depois): procura linha com "NOME"
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  const idx = lines.findIndex(l => /NOME/i.test(l));
  if (idx >= 0) {
    const candidate = lines[idx + 1] || "";
    if (candidate.length >= 5) return candidate;
  }
  return null;
}

// =========================
// Health
// =========================
router.get("/health", (req, res) => res.json({ ok: true }));

// =========================
// Saldo 2Captcha
// =========================
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

// =========================
// OCR CNH (Imagem -> Vision imediato) | (PDF -> Vision async + GCS)
// =========================
router.post("/ocr-cnh", upload.single("doc"), async (req, res) => {
  try {
    cleanupOCRJobs();

    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

    // ---- PDF (fluxo assíncrono)
    if (req.file.mimetype === "application/pdf") {
      const bucketName = process.env.OCR_BUCKET;
      if (!bucketName) {
        return res.status(500).json({
          error: "OCR_BUCKET não configurada no Cloud Run (nome do bucket do Cloud Storage).",
        });
      }

      const jobId = newJobId();
      const bucket = storage.bucket(bucketName);

      const inputPath = `ocr/input/${jobId}.pdf`;
      const outputPrefix = `ocr/output/${jobId}/`; // Vision vai gerar JSON aqui

      // 1) sobe PDF no bucket
      await bucket.file(inputPath).save(req.file.buffer, {
        contentType: "application/pdf",
        resumable: false,
      });

      const gcsInUri = `gs://${bucketName}/${inputPath}`;
      const gcsOutUri = `gs://${bucketName}/${outputPrefix}`;

      // 2) dispara OCR async no Vision
      const request = {
        requests: [
          {
            inputConfig: {
              gcsSource: { uri: gcsInUri },
              mimeType: "application/pdf",
            },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            outputConfig: {
              gcsDestination: { uri: gcsOutUri },
              batchSize: 1,
            },
          },
        ],
      };

      // Não espera finalizar aqui. Só dispara e devolve jobId.
      await visionClient.asyncBatchAnnotateFiles(request);

      ocrJobStore.set(jobId, {
        status: "processing",
        createdAt: Date.now(),
        error: null,
        result: null,
        gcsInUri,
        gcsOutPrefix: outputPrefix,
      });

      return res.json({ jobId });
    }

    // ---- IMAGEM (fluxo imediato)
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GOOGLE_VISION_API_KEY não configurada no servidor." });
    }

    const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
    const tmpPath = path.join("/tmp", `cnh_upload_${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    const ocr = new OCRExtractor(apiKey);
    const result = await ocr.extrairDadosCNH(tmpPath);

    try { fs.unlinkSync(tmpPath); } catch {}

    if (!result?.sucesso) {
      return res.status(422).json({ error: result?.erro || "Não consegui extrair os dados." });
    }

    return res.json({
      cpf: result?.dados?.cpf || null,
      cnh: result?.dados?.cnh || null,
      nome: result?.dados?.nome || null,
      confianca: result?.confianca ?? null,
    });
  } catch (err) {
    console.error("Erro /api/ocr-cnh:", err);
    return res.status(500).json({ error: err.message || "Erro interno no OCR." });
  }
});

// =========================
// Status do OCR de PDF
// =========================
router.get("/ocr-cnh/status/:jobId", async (req, res) => {
  try {
    cleanupOCRJobs();

    const { jobId } = req.params;
    const job = ocrJobStore.get(jobId);

    if (!job) {
      return res.status(404).json({ status: "not_found", error: "Job não encontrado (expirou ou reiniciou)." });
    }

    if (job.status === "done") {
      return res.json({ status: "done", ...job.result });
    }
    if (job.status === "error") {
      return res.json({ status: "error", error: job.error || "Falhou" });
    }

    // Ainda processando: verifica se já tem JSON no bucket
    const bucketName = process.env.OCR_BUCKET;
    if (!bucketName) return res.status(500).json({ status: "error", error: "OCR_BUCKET não configurada." });

    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: job.gcsOutPrefix });

    // Vision costuma gerar JSON tipo: output-1-to-1.json
    const jsonFile = files.find(f => f.name.endsWith(".json"));
    if (!jsonFile) {
      return res.json({ status: "processing" });
    }

    const [buf] = await jsonFile.download();
    const parsed = JSON.parse(buf.toString("utf8"));

    // parsed.responses[0].fullTextAnnotation.text
    const text =
      parsed?.responses?.[0]?.fullTextAnnotation?.text ||
      "";

    const cpf = extractCPF(text);
    const cnh = extractCNH(text);
    const nome = extractNome(text);

    job.status = "done";
    job.result = {
      cpf: cpf || null,
      cnh: cnh || null,
      nome: nome || null,
      // devolve só um pedacinho (pra debug)
      snippet: text ? text.slice(0, 250) : null,
    };

    return res.json({ status: "done", ...job.result });
  } catch (err) {
    console.error("Erro /api/ocr-cnh/status:", err);
    return res.status(500).json({ status: "error", error: err.message || "Erro interno" });
  }
});

// =========================
// "Banco" em memória (MVP) - Certidão
// =========================
const certidaoStore = new Map(); // caseId -> { pdfBuffer, createdAt, analysis }
const TTL_MS = 15 * 60 * 1000; // 15 min

function cleanupStore() {
  const now = Date.now();
  for (const [caseId, item] of certidaoStore.entries()) {
    if (!item?.createdAt || now - item.createdAt > TTL_MS) certidaoStore.delete(caseId);
  }
}
function newCaseId() {
  return `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * POST /api/consultar-certidao
 * Entrada: { cpf, cnh }
 * Saída: { ok, caseId, temProblemas, status, motivo, flags }
 */
router.post("/consultar-certidao", async (req, res) => {
  try {
    cleanupStore();

    const { cpf, cnh } = req.body || {};
    if (!cpf || !cnh) return res.status(400).json({ ok: false, error: "Informe cpf e cnh" });

    const pdfBuffer = await emitirCertidaoPDF({ cpf, cnh });

    const { normalizedText } = await extractCertidaoTextFromBuffer(pdfBuffer);
    const analysis = classificarCertidao(normalizedText);
    const temProblemas = analysis.status === "RESTRICAO";

    const caseId = newCaseId();
    certidaoStore.set(caseId, { pdfBuffer, createdAt: Date.now(), analysis });

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
    return res.status(400).json({ ok: false, error: err?.message || "Erro ao consultar certidão" });
  }
});

/**
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

// (Opcional) rota antiga
router.post("/certidao", async (req, res) => {
  try {
    const { cpf, cnh } = req.body || {};
    const pdfBuffer = await emitirCertidaoPDF({ cpf, cnh });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="certidao.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("Erro /api/certidao:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Erro ao emitir certidão" });
  }
});

/**
 * POST /api/consultar-multas
 */
router.post("/consultar-multas", async (req, res) => {
  try {
    const { cpf, cnh } = req.body || {};
    if (!cpf || !cnh) return res.status(400).json({ ok: false, error: "Informe cpf e cnh" });

    const apiKey = process.env.TWOCAPTCHA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error: "Serviço temporariamente indisponível (CAPTCHA não configurado)",
      });
    }

    const automation = new PontuacaoAutomation(apiKey);
    const resultado = await automation.consultarPontuacao(cpf, cnh, "RJ");

    if (!resultado.sucesso) {
      return res.status(400).json({ ok: false, error: resultado.erro || "Erro ao consultar multas" });
    }

    return res.json({
      ok: true,
      multas: resultado.multas || [],
      resumo: resultado.resumo || {},
      dataConsulta: resultado.dataConsulta,
    });
  } catch (err) {
    console.error("Erro /api/consultar-multas:", err);
    return res.status(400).json({ ok: false, error: err?.message || "Erro ao consultar multas" });
  }
});

// Stub
router.get("/pontuacao", async (req, res) => {
  return res.json({ ok: true, stub: true, msg: "Em construção: consulta de pontuação/multas" });
});

export default router;

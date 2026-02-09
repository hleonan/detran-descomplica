// src/routes/api.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import { Storage } from "@google-cloud/storage";
import vision from "@google-cloud/vision";

// Importa os serviços
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
// Configurações e Utilitários
// =========================
const storage = new Storage();
const visionClient = new vision.v1.ImageAnnotatorClient();
const ocrJobStore = new Map();
const OCR_TTL_MS = 20 * 60 * 1000;

function cleanupOCRJobs() {
  const now = Date.now();
  for (const [jobId, job] of ocrJobStore.entries()) {
    if (!job?.createdAt || now - job.createdAt > OCR_TTL_MS) ocrJobStore.delete(jobId);
  }
}

function newJobId() {
  return `ocr_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// =========================
// ROTA: Health Check
// =========================
router.get("/health", (req, res) => res.json({ ok: true }));

// =========================
// ROTA: OCR CNH (Imagem e PDF)
// =========================
router.post("/ocr-cnh", upload.single("doc"), async (req, res) => {
  try {
    cleanupOCRJobs();
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

    // --- FLUXO 1: PDF (Via Google Cloud Storage) ---
    if (req.file.mimetype === "application/pdf") {
      const bucketName = process.env.OCR_BUCKET;
      if (!bucketName) {
        return res.status(500).json({ error: "Configuração de Bucket ausente no servidor." });
      }

      const jobId = newJobId();
      const bucket = storage.bucket(bucketName);
      const inputPath = `ocr/input/${jobId}.pdf`;
      const outputPrefix = `ocr/output/${jobId}/`;

      // Salva PDF no Bucket
      await bucket.file(inputPath).save(req.file.buffer, {
        contentType: "application/pdf",
        resumable: false,
      });

      const gcsInUri = `gs://${bucketName}/${inputPath}`;
      const gcsOutUri = `gs://${bucketName}/${outputPrefix}`;

      // Dispara Vision API (Async)
      const request = {
        requests: [
          {
            inputConfig: { gcsSource: { uri: gcsInUri }, mimeType: "application/pdf" },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            outputConfig: { gcsDestination: { uri: gcsOutUri }, batchSize: 1 },
          },
        ],
      };

      await visionClient.asyncBatchAnnotateFiles(request);

      // Salva estado do Job
      ocrJobStore.set(jobId, {
        status: "processing",
        createdAt: Date.now(),
        gcsOutPrefix: outputPrefix,
      });

      return res.json({ jobId });
    }

    // --- FLUXO 2: IMAGEM (JPG/PNG - Processamento Direto) ---
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Chave de API Vision não configurada." });

    // Salva arquivo temporário para a classe ler
    const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
    const tmpPath = path.join("/tmp", `cnh_upload_${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    // Inicializa extrator
    const ocr = new OCRExtractor(apiKey);
    
    // CORREÇÃO 1: Nome da função corrigido para bater com o ocrExtractor.mjs
    const result = await ocr.extrairTextoImagem(tmpPath); 

    try { fs.unlinkSync(tmpPath); } catch {} // Limpa temp

    if (!result?.sucesso) {
      return res.status(422).json({ error: result?.erro || "Falha na leitura da imagem." });
    }

    return res.json({
      cpf: result.dados?.cpf || null,
      cnh: result.dados?.cnh || null,
      nome: result.dados?.nome || null
    });

  } catch (err) {
    console.error("Erro /api/ocr-cnh:", err);
    return res.status(500).json({ error: err.message || "Erro interno no OCR." });
  }
});

// =========================
// ROTA: Status do OCR PDF
// =========================
router.get("/ocr-cnh/status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = ocrJobStore.get(jobId);

    if (!job) return res.status(404).json({ status: "not_found" });
    if (job.status === "done") return res.json({ status: "done", ...job.result });

    // Verifica bucket
    const bucketName = process.env.OCR_BUCKET;
    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: job.gcsOutPrefix });
    const jsonFile = files.find(f => f.name.endsWith(".json"));

    if (!jsonFile) return res.json({ status: "processing" });

    // Processa resultado
    const [buf] = await jsonFile.download();
    const parsed = JSON.parse(buf.toString("utf8"));
    const text = parsed?.responses?.[0]?.fullTextAnnotation?.text || "";

    // Extração simples via Regex
    const cpfMatch = text.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    const cnhMatch = text.match(/(?<!\d)\d{11}(?!\d)/); 

    job.status = "done";
    job.result = {
      cpf: cpfMatch ? cpfMatch[0] : null,
      cnh: cnhMatch ? cnhMatch[0] : null
    };

    return res.json({ status: "done", ...job.result });

  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// =========================
// ROTA: Consultar Certidão (Detran)
// =========================
const certidaoStore = new Map();

router.post("/consultar-certidao", async (req, res) => {
  try {
    const { cpf, cnh } = req.body || {};
    if (!cpf || !cnh) return res.status(400).json({ ok: false, error: "CPF e CNH são obrigatórios." });

    // CORREÇÃO 2: Passando CPF e CNH separados, como o certidao_v3.js espera
    const pdfBuffer = await emitirCertidaoPDF(cpf, cnh);

    // Analisa o texto do PDF
    const { normalizedText } = await extractCertidaoTextFromBuffer(pdfBuffer);
    const analysis = classificarCertidao(normalizedText);
    
    // Salva na memória temporária para download
    const caseId = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    certidaoStore.set(caseId, { pdfBuffer, createdAt: Date.now() });

    return res.json({
      ok: true,
      caseId,
      temProblemas: analysis.status === "RESTRICAO",
      motivo: analysis.motivo,
      status: analysis.status
    });

  } catch (err) {
    console.error("Erro na consulta:", err);
    // Devolve o erro exato para o Frontend mostrar
    return res.status(400).json({ ok: false, error: err.message || "Erro ao consultar DETRAN." });
  }
});

// =========================
// ROTA: Baixar PDF
// =========================
router.get("/certidao/:caseId", (req, res) => {
  const item = certidaoStore.get(req.params.caseId);
  if (!item) return res.status(404).send("Certidão expirada ou não encontrada.");
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="certidao_nada_consta.pdf"');
  res.send(item.pdfBuffer);
});

// =========================
// ROTA: Consultar Multas (Pontuação)
// =========================
router.post("/consultar-multas", async (req, res) => {
  try {
    const { cpf, cnh } = req.body;
    const apiKey = process.env.TWOCAPTCHA_API_KEY;
    
    if (!apiKey) throw new Error("Serviço de Captcha indisponível.");

    const automation = new PontuacaoAutomation(apiKey);
    const resultado = await automation.consultarPontuacao(cpf, cnh, "RJ");

    if (!resultado.sucesso) throw new Error(resultado.erro || "Falha ao consultar multas.");

    return res.json({
      ok: true,
      multas: resultado.multas || [],
      resumo: resultado.resumo || {}
    });

  } catch (err) {
    console.error("Erro multas:", err);
    return res.status(400).json({ ok: false, error: err.message });
  }
});

export default router;

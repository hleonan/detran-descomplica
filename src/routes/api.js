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
import PontuacaoAutomation from "../pontuacaoAutomation.mjs";

// Sistema de Leads
import {
  registrarLead,
  buscarLead,
  listarLeads,
  estatisticasLeads,
} from "../services/leadStore.js";

const router = express.Router();

// =========================
// Upload em memória (Cloud Run-friendly)
// =========================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype);
    if (!ok) return cb(new Error("Tipo inválido. Envie PDF, JPG ou PNG."));
    cb(null, true);
  },
});

// =========================
// Configurações e Utilitários
// =========================
let storage, visionClient;
try {
  storage = new Storage();
  visionClient = new vision.v1.ImageAnnotatorClient();
} catch (e) {
  console.warn("[AVISO] Google Cloud Storage/Vision não configurado:", e.message);
}

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

function getOcrBucketName() {
  const bucketName =
    process.env.OCR_BUCKET ||
    process.env.GCS_BUCKET ||
    process.env.GOOGLE_CLOUD_STORAGE_BUCKET ||
    process.env.BUCKET_NAME;

  return bucketName?.trim() || null;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
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

    // Detectar origem (upload ou camera)
    const origem = req.body?.origem || "upload";

    // --- FLUXO 1: PDF (Via Google Cloud Storage) ---
    if (req.file.mimetype === "application/pdf") {
      const bucketName = getOcrBucketName();
      if (!bucketName) {
        return res.status(500).json({
          error: "Configuração de Bucket ausente no servidor. Defina OCR_BUCKET (ou GCS_BUCKET).",
        });
      }
      if (!storage || !visionClient) {
        return res.status(500).json({ error: "Google Cloud não configurado." });
      }

      const jobId = newJobId();
      const bucket = storage.bucket(bucketName);
      const inputPath = `ocr/input/${jobId}.pdf`;
      const outputPrefix = `ocr/output/${jobId}/`;

      await bucket.file(inputPath).save(req.file.buffer, {
        contentType: "application/pdf",
        resumable: false,
      });

      const gcsInUri = `gs://${bucketName}/${inputPath}`;
      const gcsOutUri = `gs://${bucketName}/${outputPrefix}`;

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

      ocrJobStore.set(jobId, {
        status: "processing",
        createdAt: Date.now(),
        gcsOutPrefix: outputPrefix,
        origem,
      });

      return res.json({ jobId });
    }

    // --- FLUXO 2: IMAGEM (JPG/PNG - Processamento Direto) ---
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Chave de API Vision não configurada." });

    const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
    const tmpPath = path.join("/tmp", `cnh_upload_${Date.now()}${ext}`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    const ocr = new OCRExtractor(apiKey);
    const result = await ocr.extrairTextoImagem(tmpPath);

    try { fs.unlinkSync(tmpPath); } catch {}

    if (!result?.sucesso) {
      return res.status(422).json({ error: result?.erro || "Falha na leitura da imagem." });
    }

    const cpf = onlyDigits(result.dados?.cpf);
    const cnh = onlyDigits(result.dados?.cnh);
    const nome = result.dados?.nome || null;

    // REGISTRAR LEAD (dados do OCR)
    if (cpf) {
      registrarLead({
        cpf,
        cnh,
        nome,
        origem,
        status: "DESCONHECIDO",
      });
    }

    return res.json({ cpf: cpf || null, cnh: cnh || null, nome });

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

    const bucketName = getOcrBucketName();
    if (!bucketName || !storage) return res.json({ status: "processing" });

    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: job.gcsOutPrefix });
    const jsonFile = files.find(f => f.name.endsWith(".json"));

    if (!jsonFile) return res.json({ status: "processing" });

    const [buf] = await jsonFile.download();
    const parsed = JSON.parse(buf.toString("utf8"));
    const text = parsed?.responses?.[0]?.fullTextAnnotation?.text || "";

    const cpfMatch = text.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    const cnhMatch = text.match(/(?<!\d)\d{11}(?!\d)/);

    const cpf = cpfMatch ? cpfMatch[0].replace(/\D/g, "") : null;
    const cnh = cnhMatch ? cnhMatch[0] : null;

    job.status = "done";
    job.result = { cpf, cnh };

    // REGISTRAR LEAD (dados do OCR PDF)
    if (cpf) {
      registrarLead({
        cpf,
        cnh,
        origem: job.origem || "upload",
        status: "DESCONHECIDO",
      });
    }

    return res.json({ status: "done", cpf, cnh });

  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// =========================
// ROTA: Consultar Certidão (Detran)
// =========================
const certidaoStore = new Map();
const CERTIDAO_TTL_MS = 60 * 60 * 1000;

function cleanupCertidoes() {
  const now = Date.now();
  for (const [id, item] of certidaoStore.entries()) {
    if (now - item.createdAt > CERTIDAO_TTL_MS) certidaoStore.delete(id);
  }
}

function isErroDadosCertidao(mensagem = "") {
  return /recusou os dados|verifique cpf e cnh|cpf invalido|cnh invalida|obrigatorios/i.test(String(mensagem));
}

function isErroCertidaoRetryable(mensagem = "") {
  const msg = String(mensagem || "");
  if (isErroDadosCertidao(msg)) return false;

  return /DETRAN_FAIL|2Captcha|timeout|timed out|ERR_CONNECTION|net::|ECONNRESET|ETIMEDOUT|ENOTFOUND|navigation|Target closed|Execution context was destroyed|Protocol error|indisponivel|captcha/i.test(msg);
}

router.post("/consultar-certidao", async (req, res) => {
  try {
    cleanupCertidoes();
    const { cpf, cnh, origem } = req.body || {};
    const cpfDigits = onlyDigits(cpf);
    const cnhDigits = onlyDigits(cnh);

    if (!cpfDigits || !cnhDigits) return res.status(400).json({ ok: false, error: "CPF e CNH são obrigatórios." });
    if (cpfDigits.length !== 11) return res.status(400).json({ ok: false, error: "CPF inválido." });
    if (cnhDigits.length < 9 || cnhDigits.length > 11) return res.status(400).json({ ok: false, error: "CNH inválida." });
    
    // REGISTRAR LEAD (início da consulta)
    registrarLead({
      cpf: cpfDigits,
      cnh: cnhDigits,
      origem: origem || "manual",
      status: "DESCONHECIDO",
    });

    // Chama a automação do Playwright com retry para instabilidades transitórias.
    let resultado;
    let ultimoErro;
    const maxTentativas = 2;
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
      try {
        resultado = await emitirCertidaoPDF(cpfDigits, cnhDigits);
        break;
      } catch (err) {
        ultimoErro = err;
        const mensagemErro = err?.message || String(err);
        const retryable = isErroCertidaoRetryable(mensagemErro);

        console.warn(`[DETRAN] Falha na consulta de certidao (tentativa ${tentativa}/${maxTentativas}): ${mensagemErro}`);

        if (!retryable || tentativa === maxTentativas) {
          throw err;
        }

        await new Promise((resolve) => setTimeout(resolve, 1800 * tentativa));
      }
    }

    if (!resultado) {
      throw ultimoErro || new Error("Falha ao consultar DETRAN.");
    }

    const { pdfBuffer, analise } = resultado;

    // ATUALIZAR LEAD com dados da certidão (extraídos do HTML, não do PDF)
    registrarLead({
      cpf: cpfDigits,
      cnh: cnhDigits,
      nome: analise.nome || null,
      origem: origem || "manual",
      status: analise.status,
      motivo: analise.motivo,
      extras: {
        numeroCertidao: analise.numeroCertidao || null,
        dataConsulta: new Date().toISOString(),
        temProblemas: analise.temProblemas,
        dados: analise.dados || {},
      },
    });

    // Salva na memória temporária para download
    const caseId = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    certidaoStore.set(caseId, { pdfBuffer, createdAt: Date.now() });

    return res.json({
      ok: true,
      caseId,
      pdfBase64: pdfBuffer.toString("base64"),
      temProblemas: analise.temProblemas,
      temMultas: analise.temMultas || false,
      temSuspensao: analise.temSuspensao || false,
      temCassacao: analise.temCassacao || false,
      motivo: analise.motivo,
      status: analise.status,
      nome: analise.nome || null,
      numeroCertidao: analise.numeroCertidao || null,
    });

  } catch (err) {
    console.error("Erro na consulta:", err);
    const mensagem = err?.message || "Erro ao consultar DETRAN.";
    const indisponivel = isErroCertidaoRetryable(mensagem);
    return res.status(indisponivel ? 503 : 400).json({
      ok: false,
      error: mensagem,
      retryable: indisponivel,
    });
  }
});

// =========================
// ROTA: Baixar PDF
// =========================
router.get("/certidao/:caseId", (req, res) => {
  const item = certidaoStore.get(req.params.caseId);
  if (!item) return res.status(404).send("Certidão expirada ou não encontrada.");

  if (Date.now() - item.createdAt > CERTIDAO_TTL_MS) {
    certidaoStore.delete(req.params.caseId);
    return res.status(404).send("Certidão expirada ou não encontrada.");
  }

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
    const cpfDigits = onlyDigits(cpf);
    const cnhDigits = onlyDigits(cnh);
    const apiKey = process.env.TWOCAPTCHA_API_KEY;

    if (!apiKey) throw new Error("Serviço de Captcha indisponível.");

    const automation = new PontuacaoAutomation(apiKey);
    const resultado = await automation.consultarPontuacao(cpfDigits, cnhDigits, "RJ");

    if (!resultado.sucesso) throw new Error(resultado.erro || "Falha ao consultar multas.");

    return res.json({
      ok: true,
      multas: resultado.multas || [],
      resumo: resultado.resumo || {},
    });

  } catch (err) {
    console.error("Erro multas:", err);
    const mensagem = err?.message || "Erro ao consultar multas.";
    const indisponivel = /DETRAN_MULTAS_OFFLINE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|2Captcha|timeout|page\.goto|is interrupted by another navigation|Navigation to/i.test(mensagem);
    const mensagemPublica = /page\.goto|Call log:|navigating to|is interrupted by another navigation|Navigation to/i.test(mensagem)
      ? "Falha temporaria ao acessar o portal de multas do DETRAN-RJ. Tente novamente em alguns minutos."
      : mensagem;
    return res.status(indisponivel ? 503 : 400).json({
      ok: false,
      error: mensagemPublica,
      retryable: indisponivel,
    });
  }
});

// =========================
// ROTAS DE LEADS (Gestão)
// =========================

// Listar todos os leads
router.get("/leads", (req, res) => {
  try {
    const leads = listarLeads();
    const stats = estatisticasLeads();
    return res.json({ ok: true, leads, stats });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Buscar lead por CPF
router.get("/leads/:cpf", (req, res) => {
  try {
    const lead = buscarLead(req.params.cpf);
    if (!lead) return res.status(404).json({ ok: false, error: "Lead não encontrado." });
    return res.json({ ok: true, lead });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Estatísticas dos leads
router.get("/leads-stats", (req, res) => {
  try {
    const stats = estatisticasLeads();
    return res.json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;

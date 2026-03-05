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
const DEFAULT_OCR_BUCKET = "detran-descomplica-ocr";
const multasCacheStore = new Map();
const multasInFlight = new Map();
const MULTAS_CACHE_TTL_MS = 30 * 60 * 1000;

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

  return bucketName?.trim() || DEFAULT_OCR_BUCKET;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function multasCacheKey(cpf, cnh) {
  return `${onlyDigits(cpf)}:${onlyDigits(cnh)}`;
}

function cleanupMultasCache() {
  const now = Date.now();
  for (const [key, item] of multasCacheStore.entries()) {
    if (!item?.updatedAt || now - item.updatedAt > MULTAS_CACHE_TTL_MS) {
      multasCacheStore.delete(key);
    }
  }
}

function getCachedMultas(cpf, cnh) {
  cleanupMultasCache();
  const key = multasCacheKey(cpf, cnh);
  const item = multasCacheStore.get(key);
  if (!item || item.status !== "done" || !item.data) return null;
  return item.data;
}

function isErroMultasRetryable(mensagem = "") {
  const normalizada = String(mensagem || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /DETRAN_MULTAS_OFFLINE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|2Captcha|timeout|timed out|page\.goto|is interrupted by another navigation|Navigation to|Target closed|Execution context was destroyed|Protocol error|net::|captcha|token nao retornado/i.test(normalizada);
}

async function executarConsultaMultasComRetry(cpfDigits, cnhDigits, apiKey) {
  let resultado = null;
  let ultimoErro = null;
  const maxTentativas = 2;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
    try {
      const automation = new PontuacaoAutomation(apiKey);
      resultado = await automation.consultarPontuacao(cpfDigits, cnhDigits, "RJ");
      if (!resultado?.sucesso) throw new Error(resultado?.erro || "Falha ao consultar multas.");
      break;
    } catch (err) {
      ultimoErro = err;
      const mensagemErro = err?.message || String(err);
      const retryable = isErroMultasRetryable(mensagemErro);

      console.warn(`[MULTAS] Falha na consulta (tentativa ${tentativa}/${maxTentativas}): ${mensagemErro}`);

      if (!retryable || tentativa === maxTentativas) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500 * tentativa));
    }
  }

  if (!resultado?.sucesso) throw ultimoErro || new Error("Falha ao consultar multas.");
  return {
    multas: resultado.multas || [],
    resumo: resultado.resumo || {},
  };
}

async function consultarMultasComCache(cpfDigits, cnhDigits, apiKey) {
  const key = multasCacheKey(cpfDigits, cnhDigits);
  const cacheValido = getCachedMultas(cpfDigits, cnhDigits);
  if (cacheValido) return { ...cacheValido, fromCache: true };

  if (!apiKey) throw new Error("Serviço de Captcha indisponível.");

  if (multasInFlight.has(key)) {
    return multasInFlight.get(key);
  }

  const now = Date.now();
  multasCacheStore.set(key, {
    status: "processing",
    updatedAt: now,
    error: null,
  });

  const promise = (async () => {
    try {
      const data = await executarConsultaMultasComRetry(cpfDigits, cnhDigits, apiKey);
      multasCacheStore.set(key, {
        status: "done",
        updatedAt: Date.now(),
        data,
        error: null,
      });
      return { ...data, fromCache: false };
    } catch (err) {
      multasCacheStore.set(key, {
        status: "error",
        updatedAt: Date.now(),
        error: err?.message || String(err),
      });
      throw err;
    } finally {
      multasInFlight.delete(key);
    }
  })();

  multasInFlight.set(key, promise);
  return promise;
}

function extrairCpfCnhDoTexto(texto = "") {
  const textoSeguro = String(texto || "");

  const cpfMatch = textoSeguro.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
  const cpf = cpfMatch ? cpfMatch[0].replace(/\D/g, "") : null;

  let cnh = null;

  const cnhComRotulo =
    textoSeguro.match(/CNH[^0-9]{0,20}(\d{9,11})/i) ||
    textoSeguro.match(/REGISTRO[^0-9]{0,20}(\d{9,11})/i);
  if (cnhComRotulo?.[1]) cnh = onlyDigits(cnhComRotulo[1]).slice(0, 11);

  if (!cnh) {
    const candidatos11 = Array.from(textoSeguro.matchAll(/(?<!\d)\d{11}(?!\d)/g)).map((m) => m[0]);
    if (candidatos11.length) {
      cnh = candidatos11.find((num) => num !== cpf) || candidatos11[0];
    }
  }

  return { cpf, cnh: cnh || null };
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

    // --- FLUXO 1: PDF (Google Vision via Google Cloud Storage) ---
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

    const { cpf, cnh } = extrairCpfCnhDoTexto(text);

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

    // Prefetch assíncrono das multas para acelerar a tela 4->6.
    // Só pré-consulta quando há ocorrência para evitar custo desnecessário de captcha.
    if (analise.temProblemas && process.env.TWOCAPTCHA_API_KEY) {
      consultarMultasComCache(cpfDigits, cnhDigits, process.env.TWOCAPTCHA_API_KEY)
        .then(() => {
          console.log(`[MULTAS] Prefetch concluído para ${cpfDigits}.`);
        })
        .catch((err) => {
          console.warn(`[MULTAS] Prefetch falhou para ${cpfDigits}: ${err?.message || err}`);
        });
    }

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

    if (!cpfDigits || !cnhDigits) {
      return res.status(400).json({ ok: false, error: "CPF e CNH são obrigatórios." });
    }
    if (cpfDigits.length !== 11) {
      return res.status(400).json({ ok: false, error: "CPF inválido." });
    }
    if (cnhDigits.length < 9 || cnhDigits.length > 11) {
      return res.status(400).json({ ok: false, error: "CNH inválida." });
    }

    const resultado = await consultarMultasComCache(cpfDigits, cnhDigits, apiKey);

    return res.json({
      ok: true,
      multas: resultado.multas,
      resumo: resultado.resumo,
      cache: resultado.fromCache ? "hit" : "miss",
    });

  } catch (err) {
    console.error("Erro multas:", err);
    const mensagem = err?.message || "Erro ao consultar multas.";
    const mensagemNormalizada = String(mensagem || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const indisponivel = isErroMultasRetryable(mensagem);
    const mensagemPublica = /DETRAN_MULTAS_OFFLINE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(mensagem)
      ? "Falha ao acessar o portal de multas do DETRAN-RJ a partir do servidor. Tente novamente em alguns minutos."
      : /page\.goto|Call log:|navigating to|is interrupted by another navigation|Navigation to/i.test(mensagem)
      ? "Falha temporaria ao acessar o portal de multas do DETRAN-RJ. Tente novamente em alguns minutos."
      : /captcha|token nao retornado/i.test(mensagemNormalizada)
      ? "Falha temporária na validação automática do CAPTCHA. Tente novamente em alguns instantes."
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

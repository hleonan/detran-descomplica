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
import ProcessoSuspCassAutomation from "../processoSuspCassAutomation.mjs";

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
    const mime = String(file.mimetype || "").toLowerCase();
    const nome = String(file.originalname || "").toLowerCase();
    const isPdf = mime === "application/pdf" || nome.endsWith(".pdf");
    const isJpeg = mime === "image/jpeg" || mime === "image/jpg" || nome.endsWith(".jpg") || nome.endsWith(".jpeg");
    const isPng = mime === "image/png" || nome.endsWith(".png");
    const ok = isPdf || isJpeg || isPng;
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
const OCR_TMP_DIR = "/tmp/ocr-cnh-results";
const multasCacheStore = new Map();
const multasInFlight = new Map();
const MULTAS_CACHE_TTL_MS = 60 * 60 * 1000;
const processoCacheStore = new Map();
const processoInFlight = new Map();
const PROCESSO_CACHE_TTL_MS = 60 * 60 * 1000;
const certidaoStore = new Map();
const certidaoConsultaCache = new Map();
const CERTIDAO_TTL_MS = 60 * 60 * 1000;

function cleanupOCRJobs() {
  const now = Date.now();
  for (const [jobId, job] of ocrJobStore.entries()) {
    if (!job?.createdAt || now - job.createdAt > OCR_TTL_MS) ocrJobStore.delete(jobId);
  }

  try {
    if (!fs.existsSync(OCR_TMP_DIR)) return;
    const arquivos = fs.readdirSync(OCR_TMP_DIR);
    for (const arquivo of arquivos) {
      if (!arquivo.endsWith(".json")) continue;
      const caminho = path.join(OCR_TMP_DIR, arquivo);
      const stat = fs.statSync(caminho);
      if (!stat?.mtimeMs || now - stat.mtimeMs > OCR_TTL_MS) {
        fs.unlinkSync(caminho);
      }
    }
  } catch (err) {
    console.warn("[OCR TMP] Falha ao limpar temporários:", err?.message || err);
  }
}

function newJobId() {
  return `ocr_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function ocrTmpFilePath(jobId = "") {
  const safeJobId = String(jobId || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return path.join(OCR_TMP_DIR, `${safeJobId}.json`);
}

function saveOcrTempResult(jobId, payload = {}) {
  if (!jobId) return;
  try {
    fs.mkdirSync(OCR_TMP_DIR, { recursive: true });
    fs.writeFileSync(
      ocrTmpFilePath(jobId),
      JSON.stringify(
        {
          status: "done",
          createdAt: Date.now(),
          ...payload,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    console.warn("[OCR TMP] Falha ao salvar cache:", err?.message || err);
  }
}

function getOcrTempResult(jobId) {
  if (!jobId) return null;
  try {
    const filePath = ocrTmpFilePath(jobId);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.createdAt || Date.now() - parsed.createdAt > OCR_TTL_MS) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn("[OCR TMP] Falha ao carregar cache:", err?.message || err);
    return null;
  }
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

function normalizeDateBR(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return text;

  const digits = onlyDigits(text);
  if (digits.length === 8) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return text;
}

function normalizeOptionalText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeNameForCompare(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulName(value = "") {
  const normalized = normalizeNameForCompare(value);
  if (!normalized) return false;
  if (normalized.split(" ").length < 2) return false;
  if (/^(NOME|E SOBRENOME|DESCONHECIDO|NAO IDENTIFICADO|NAO INFORMADO)$/.test(normalized)) return false;
  return normalized.length >= 8;
}

function namesAreCompatible(expectedName = "", certidaoName = "") {
  const expectedNorm = normalizeNameForCompare(expectedName);
  const certidaoNorm = normalizeNameForCompare(certidaoName);
  if (!expectedNorm || !certidaoNorm) return true;
  if (expectedNorm === certidaoNorm) return true;
  if (expectedNorm.includes(certidaoNorm) || certidaoNorm.includes(expectedNorm)) return true;

  const expectedTokens = new Set(
    expectedNorm
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  );
  const certidaoTokens = new Set(
    certidaoNorm
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  );

  if (!expectedTokens.size || !certidaoTokens.size) return true;

  let intersection = 0;
  for (const token of expectedTokens) {
    if (certidaoTokens.has(token)) intersection += 1;
  }

  const overlapExpected = intersection / expectedTokens.size;
  const overlapCertidao = intersection / certidaoTokens.size;
  return overlapExpected >= 0.6 || overlapCertidao >= 0.6;
}

function normalizeCnhDigits(value = "") {
  const digits = onlyDigits(value || "");
  if (!digits) return null;
  if (digits.length >= 9 && digits.length <= 11) return digits;

  if (digits.length > 11) {
    const windows = [];
    for (let i = 0; i <= digits.length - 11; i += 1) {
      windows.push(digits.slice(i, i + 11));
    }

    if (windows.length) {
      const scored = windows
        .map((windowValue, idx) => {
          let score = 0;
          if (/^0/.test(windowValue)) score += 2;
          if (!/^(\d)\1+$/.test(windowValue)) score += 2;
          if (!/(\d)\1{6,}/.test(windowValue)) score += 1;
          if (idx === 0 || idx === windows.length - 1) score += 1;
          return { windowValue, score, idx };
        })
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.idx - b.idx;
        });
      return scored[0]?.windowValue || digits.slice(-11);
    }
    return digits.slice(-11);
  }

  return digits;
}

function buildCnhCandidatesForConsulta(cnhDigits = "") {
  const base = normalizeCnhDigits(cnhDigits || "");
  if (!base) return [];

  const set = new Set();
  const addCandidate = (value) => {
    const normalized = normalizeCnhDigits(value || "");
    if (!normalized) return;
    if (normalized.length < 9 || normalized.length > 11) return;
    set.add(normalized);
  };

  addCandidate(base);

  const baseDigits = onlyDigits(base);
  if (baseDigits.length < 11) {
    addCandidate(baseDigits.padStart(11, "0"));
  }

  let semZeros = baseDigits;
  while (semZeros.length > 9 && semZeros.startsWith("0")) {
    semZeros = semZeros.slice(1);
    addCandidate(semZeros);
  }

  if (baseDigits.length === 11) {
    addCandidate(baseDigits.slice(1));
    addCandidate(baseDigits.slice(2));
  }

  return Array.from(set);
}

function normalizeCnhData(dados = {}) {
  const cpfDigits = onlyDigits(dados.cpf || "") || null;
  let cnhDigits = normalizeCnhDigits(dados.cnh || "");
  if (cnhDigits && cpfDigits && cnhDigits === cpfDigits) {
    cnhDigits = null;
  }

  const nomeNormalizado = normalizeOptionalText(dados.nome);
  return {
    cpf: cpfDigits,
    cnh: cnhDigits || null,
    nome: isMeaningfulName(nomeNormalizado) ? nomeNormalizado : null,
    dataNascimento: normalizeDateBR(dados.dataNascimento || "") || null,
    dataPrimeiraHabilitacao: normalizeDateBR(dados.dataPrimeiraHabilitacao || "") || null,
    validadeCnh: normalizeDateBR(dados.validadeCnh || "") || null,
    categoriaCnh: normalizeOptionalText(dados.categoriaCnh || dados.categoria || ""),
    docIdentidade: normalizeOptionalText(dados.docIdentidade || ""),
    orgaoEmissor: normalizeOptionalText(dados.orgaoEmissor || ""),
    ufEmissor: normalizeOptionalText(dados.ufEmissor || ""),
    dataEmissaoCnh: normalizeDateBR(dados.dataEmissaoCnh || "") || null,
    localEmissaoCnh: normalizeOptionalText(dados.localEmissaoCnh || ""),
  };
}

function extrairDadosCnhDoTexto(texto = "") {
  const extrator = new OCRExtractor(null);
  return normalizeCnhData(extrator.extrairDadosDoTexto(String(texto || "")));
}

function certidaoConsultaKey(cpf, cnh) {
  return `${onlyDigits(cpf)}:${onlyDigits(cnh)}`;
}

function multasCacheKey(cpf, cnh) {
  return `${onlyDigits(cpf)}:${onlyDigits(cnh)}`;
}

function processoCacheKey(cpf, cnh, dataNascimento, dataPrimeiraHabilitacao, tipo = "suspensao") {
  const tipoNormalizado = String(tipo || "suspensao").toLowerCase() === "cassacao" ? "cassacao" : "suspensao";
  return `${onlyDigits(cpf)}:${onlyDigits(cnh)}:${normalizeDateBR(dataNascimento)}:${normalizeDateBR(dataPrimeiraHabilitacao)}:${tipoNormalizado}`;
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
  return /DETRAN_MULTAS_OFFLINE|DETRAN_MULTAS_DETALHE_NAO_ABERTO|DETRAN_MULTAS_DETALHE_VAZIO|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|2Captcha|timeout|timed out|page\.goto|is interrupted by another navigation|Navigation to|Target closed|Execution context was destroyed|Protocol error|net::|captcha|token nao retornado/i.test(normalizada);
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

async function consultarMultasComCache(cpfDigits, cnhDigits, apiKey, options = {}) {
  const { forceRefresh = false } = options;
  const key = multasCacheKey(cpfDigits, cnhDigits);
  if (forceRefresh) {
    multasCacheStore.delete(key);
  } else {
    const cacheValido = getCachedMultas(cpfDigits, cnhDigits);
    if (cacheValido) return { ...cacheValido, fromCache: true };
  }

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

function cleanupProcessoCache() {
  const now = Date.now();
  for (const [key, item] of processoCacheStore.entries()) {
    if (!item?.updatedAt || now - item.updatedAt > PROCESSO_CACHE_TTL_MS) {
      processoCacheStore.delete(key);
    }
  }
}

function getCachedProcesso(cpf, cnh, dataNascimento, dataPrimeiraHabilitacao, tipo) {
  cleanupProcessoCache();
  const key = processoCacheKey(cpf, cnh, dataNascimento, dataPrimeiraHabilitacao, tipo);
  const item = processoCacheStore.get(key);
  if (!item || item.status !== "done" || !item.data) return null;
  return item.data;
}

function isErroProcessoRetryable(mensagem = "") {
  const normalizada = String(mensagem || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /DETRAN_PROCESSO_OFFLINE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|2Captcha|timeout|timed out|page\.goto|is interrupted by another navigation|Navigation to|Target closed|Execution context was destroyed|Protocol error|net::|captcha|token nao retornado|recaptcha/i.test(normalizada);
}

async function executarConsultaProcessoComRetry(
  cpfDigits,
  cnhDigits,
  dataNascimento,
  dataPrimeiraHabilitacao,
  tipo,
  apiKey
) {
  let resultado = null;
  let ultimoErro = null;
  const maxTentativas = 2;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
    try {
      const automation = new ProcessoSuspCassAutomation(apiKey);
      resultado = await automation.consultarProcesso(
        cpfDigits,
        cnhDigits,
        dataNascimento,
        dataPrimeiraHabilitacao,
        tipo
      );
      if (!resultado?.sucesso) throw new Error(resultado?.erro || "Falha ao consultar processo administrativo.");
      break;
    } catch (err) {
      ultimoErro = err;
      const mensagemErro = err?.message || String(err);
      const retryable = isErroProcessoRetryable(mensagemErro);

      console.warn(
        `[PROCESSO] Falha na consulta (${tipo}) tentativa ${tentativa}/${maxTentativas}: ${mensagemErro}`
      );

      if (!retryable || tentativa === maxTentativas) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500 * tentativa));
    }
  }

  if (!resultado?.sucesso) throw ultimoErro || new Error("Falha ao consultar processo administrativo.");
  return resultado;
}

async function consultarProcessoComCache(
  cpfDigits,
  cnhDigits,
  dataNascimento,
  dataPrimeiraHabilitacao,
  tipo,
  apiKey,
  options = {}
) {
  const { forceRefresh = false } = options;
  const key = processoCacheKey(cpfDigits, cnhDigits, dataNascimento, dataPrimeiraHabilitacao, tipo);

  if (forceRefresh) {
    processoCacheStore.delete(key);
  } else {
    const cacheValido = getCachedProcesso(
      cpfDigits,
      cnhDigits,
      dataNascimento,
      dataPrimeiraHabilitacao,
      tipo
    );
    if (cacheValido) return { ...cacheValido, fromCache: true };
  }

  if (!apiKey) throw new Error("Serviço de Captcha indisponível.");

  if (processoInFlight.has(key)) {
    return processoInFlight.get(key);
  }

  processoCacheStore.set(key, {
    status: "processing",
    updatedAt: Date.now(),
    error: null,
  });

  const promise = (async () => {
    try {
      const data = await executarConsultaProcessoComRetry(
        cpfDigits,
        cnhDigits,
        dataNascimento,
        dataPrimeiraHabilitacao,
        tipo,
        apiKey
      );
      processoCacheStore.set(key, {
        status: "done",
        updatedAt: Date.now(),
        data,
        error: null,
      });
      return { ...data, fromCache: false };
    } catch (err) {
      processoCacheStore.set(key, {
        status: "error",
        updatedAt: Date.now(),
        error: err?.message || String(err),
      });
      throw err;
    } finally {
      processoInFlight.delete(key);
    }
  })();

  processoInFlight.set(key, promise);
  return promise;
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

    const mime = String(req.file.mimetype || "").toLowerCase();
    const nomeArquivo = String(req.file.originalname || "").toLowerCase();
    const isPdf = mime.includes("pdf") || nomeArquivo.endsWith(".pdf");

    // --- FLUXO 1: PDF (Google Vision via Google Cloud Storage) ---
    if (isPdf) {
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
    const apiKey = process.env.GOOGLE_VISION_API_KEY?.trim();
    let result = null;

    if (apiKey) {
      const ext = req.file.mimetype === "image/png" ? ".png" : ".jpg";
      const tmpPath = path.join("/tmp", `cnh_upload_${Date.now()}${ext}`);
      fs.writeFileSync(tmpPath, req.file.buffer);

      const ocr = new OCRExtractor(apiKey);
      result = await ocr.extrairTextoImagem(tmpPath);

      try { fs.unlinkSync(tmpPath); } catch {}
    } else if (visionClient) {
      const [visionResp] = await visionClient.documentTextDetection({
        image: { content: req.file.buffer },
      });

      const textoCompleto =
        visionResp?.fullTextAnnotation?.text ||
        visionResp?.textAnnotations?.[0]?.description ||
        "";

      const ocr = new OCRExtractor(null);
      const dados = ocr.extrairDadosDoTexto(textoCompleto);

      result = {
        sucesso: Boolean(textoCompleto),
        dados,
        textoCompleto,
        confianca: ocr.calcularConfianca(dados?.cpf, dados?.cnh),
        erro: textoCompleto ? null : "Falha na leitura da imagem.",
      };
    } else {
      return res.status(500).json({
        error:
          "OCR de imagem indisponível no servidor. Configure GOOGLE_VISION_API_KEY ou credenciais do Google Cloud Vision.",
      });
    }

    if (!result?.sucesso) {
      return res.status(422).json({ error: result?.erro || "Falha na leitura da imagem." });
    }

    const dadosCnh = normalizeCnhData(result.dados || {});
    const { cpf, cnh, nome, ...dadosCnhExtras } = dadosCnh;
    const ocrCacheId = newJobId();

    ocrJobStore.set(ocrCacheId, {
      status: "done",
      createdAt: Date.now(),
      origem,
      result: dadosCnh,
    });
    saveOcrTempResult(ocrCacheId, dadosCnh);

    // REGISTRAR LEAD (dados do OCR)
    if (cpf) {
      registrarLead({
        cpf,
        cnh,
        nome,
        origem,
        status: "DESCONHECIDO",
        dadosExtras: {
          ...dadosCnhExtras,
          fonteDadosCnh: "ocr_imagem",
        },
      });
    }

    return res.json({ ...dadosCnh, ocrCacheId });

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

    if (!job) {
      const tmpResult = getOcrTempResult(jobId);
      if (tmpResult) return res.json({ status: "done", ...tmpResult });
      return res.status(404).json({ status: "not_found" });
    }
    if (job.status === "done") {
      const result = job.result || getOcrTempResult(jobId) || {};
      return res.json({ status: "done", ...result });
    }

    const bucketName = getOcrBucketName();
    if (!bucketName || !storage) return res.json({ status: "processing" });

    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: job.gcsOutPrefix });
    const jsonFile = files.find(f => f.name.endsWith(".json"));

    if (!jsonFile) return res.json({ status: "processing" });

    const [buf] = await jsonFile.download();
    const parsed = JSON.parse(buf.toString("utf8"));
    const text = parsed?.responses?.[0]?.fullTextAnnotation?.text || "";

    const dadosCnh = extrairDadosCnhDoTexto(text);
    const { cpf, cnh, nome, ...dadosCnhExtras } = dadosCnh;

    job.status = "done";
    job.result = dadosCnh;
    saveOcrTempResult(jobId, dadosCnh);

    // REGISTRAR LEAD (dados do OCR PDF)
    if (cpf) {
      registrarLead({
        cpf,
        cnh,
        nome,
        origem: job.origem || "upload",
        status: "DESCONHECIDO",
        dadosExtras: {
          ...dadosCnhExtras,
          fonteDadosCnh: "ocr_pdf",
        },
      });
    }

    return res.json({ status: "done", ...dadosCnh });

  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

function cleanupCertidoes() {
  const now = Date.now();
  for (const [id, item] of certidaoStore.entries()) {
    if (now - item.createdAt > CERTIDAO_TTL_MS) certidaoStore.delete(id);
  }

  for (const [key, item] of certidaoConsultaCache.entries()) {
    const expirado = !item?.createdAt || now - item.createdAt > CERTIDAO_TTL_MS;
    const caseIdInvalido = !item?.caseId || !certidaoStore.has(item.caseId);
    if (expirado || caseIdInvalido) certidaoConsultaCache.delete(key);
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

function deveRetentarCertidaoNoBackend(mensagem = "", tentativa = 1, maxTentativas = 2) {
  if (tentativa >= maxTentativas) return false;
  if (isErroCertidaoRetryable(mensagem)) return true;
  // O DETRAN pode recusar dados em uma tentativa e aceitar na seguinte (instabilidade/captcha).
  return /recusou os dados|verifique cpf e cnh|cnh nao cadastrada|cpf nao cadastrado/i.test(
    String(mensagem || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
  );
}

router.post("/consultar-certidao", async (req, res) => {
  try {
    cleanupCertidoes();
    const requestBody = req.body || {};
    const { cpf, cnh, origem, dataNascimento, dataPrimeiraHabilitacao } = requestBody;
    const dataNascimentoBr = normalizeDateBR(dataNascimento);
    const dataPrimeiraHabilitacaoBr = normalizeDateBR(dataPrimeiraHabilitacao);
    const dadosCnhRecebidos = normalizeCnhData({
      ...requestBody,
      dataNascimento: dataNascimentoBr || requestBody?.dataNascimento,
      dataPrimeiraHabilitacao: dataPrimeiraHabilitacaoBr || requestBody?.dataPrimeiraHabilitacao,
    });
    const cpfDigits = dadosCnhRecebidos.cpf || onlyDigits(cpf);
    const cnhCandidates = buildCnhCandidatesForConsulta(dadosCnhRecebidos.cnh || cnh);
    const cnhPrincipal = cnhCandidates[0] || null;
    const { cpf: _cpfIgnorado, cnh: _cnhIgnorado, nome: nomeCnhRecebido, ...dadosCnhExtrasRecebidos } =
      dadosCnhRecebidos;
    const consultaKey = certidaoConsultaKey(cpfDigits, cnhPrincipal);

    if (!cpfDigits || !cnhPrincipal) return res.status(400).json({ ok: false, error: "CPF e CNH são obrigatórios." });
    if (cpfDigits.length !== 11) return res.status(400).json({ ok: false, error: "CPF inválido." });
    if (cnhPrincipal.length < 9 || cnhPrincipal.length > 11) return res.status(400).json({ ok: false, error: "CNH inválida." });
    
    // REGISTRAR LEAD (início da consulta)
    registrarLead({
      cpf: cpfDigits,
      cnh: cnhPrincipal,
      nome: nomeCnhRecebido || null,
      origem: origem || "manual",
      status: "DESCONHECIDO",
      dadosExtras: {
        ...dadosCnhExtrasRecebidos,
        fonteDadosCnh: "consulta_certidao",
      },
    });

    const cacheConsulta = certidaoConsultaCache.get(consultaKey);
    if (cacheConsulta) {
      const cachePdf = certidaoStore.get(cacheConsulta.caseId);
      if (cachePdf && Date.now() - cachePdf.createdAt <= CERTIDAO_TTL_MS) {
        console.log(`[DETRAN] Cache hit para ${cpfDigits}.`);
        return res.json({
          ...cacheConsulta.payload,
          caseId: cacheConsulta.caseId,
          pdfBase64: cachePdf.pdfBuffer.toString("base64"),
          cache: "hit",
        });
      }
      certidaoConsultaCache.delete(consultaKey);
    }

    // Chama a automação do Playwright com retry para instabilidades transitórias.
    let resultado;
    let ultimoErro;
    let cnhUsadaConsulta = cnhPrincipal;
    const maxTentativasPorCnh = 2;

    for (let idxCnh = 0; idxCnh < cnhCandidates.length && !resultado; idxCnh += 1) {
      const cnhCandidata = cnhCandidates[idxCnh];
      cnhUsadaConsulta = cnhCandidata;

      for (let tentativa = 1; tentativa <= maxTentativasPorCnh; tentativa += 1) {
        try {
          resultado = await emitirCertidaoPDF(cpfDigits, cnhCandidata);
          break;
        } catch (err) {
          ultimoErro = err;
          const mensagemErro = err?.message || String(err);
          const retryable = deveRetentarCertidaoNoBackend(mensagemErro, tentativa, maxTentativasPorCnh);
          const mensagemNormalizada = String(mensagemErro || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
          const erroDados = isErroDadosCertidao(mensagemErro);
          const cnhNaoCadastrada = /CNH NAO CADASTRADA|CNH INEXISTENTE|CNH NAO ENCONTRADA/.test(
            mensagemNormalizada.toUpperCase()
          );
          const temProximaCnh = idxCnh < cnhCandidates.length - 1;

          console.warn(
            `[DETRAN] Falha na consulta de certidao (CNH ${cnhCandidata}, tentativa ${tentativa}/${maxTentativasPorCnh}): ${mensagemErro}`
          );

          if ((erroDados || cnhNaoCadastrada) && temProximaCnh && tentativa === maxTentativasPorCnh) {
            console.warn(
              `[DETRAN] Tentando variacao de CNH (${cnhCandidata} -> ${cnhCandidates[idxCnh + 1]}).`
            );
            break;
          }

          if (erroDados && tentativa < maxTentativasPorCnh) {
            await new Promise((resolve) => setTimeout(resolve, 1800 * tentativa));
            continue;
          }

          if (!retryable || tentativa === maxTentativasPorCnh) {
            throw err;
          }

          await new Promise((resolve) => setTimeout(resolve, 1800 * tentativa));
        }
      }
    }

    if (!resultado) {
      throw ultimoErro || new Error("Falha ao consultar DETRAN.");
    }

    const { pdfBuffer, analise } = resultado;
    const nomeFinalCertidao = normalizeOptionalText(analise.nome) || null;

    if (isMeaningfulName(nomeCnhRecebido) && isMeaningfulName(nomeFinalCertidao)) {
      const nomesCompativeis = namesAreCompatible(nomeCnhRecebido, nomeFinalCertidao);
      if (!nomesCompativeis) {
        console.warn(
          `[DETRAN] Divergencia de nome detectada. OCR="${nomeCnhRecebido}" | Certidao="${nomeFinalCertidao}".`
        );
        throw new Error(
          "DETRAN_FAIL: Os dados extraidos da CNH nao conferem com o nome da certidao emitida. Reenvie o documento ou digite os dados manualmente."
        );
      }
    }

    // ATUALIZAR LEAD com dados da certidão (extraídos do HTML, não do PDF)
    registrarLead({
      cpf: cpfDigits,
      cnh: cnhUsadaConsulta || cnhPrincipal,
      nome: nomeFinalCertidao || nomeCnhRecebido || null,
      origem: origem || "manual",
      status: analise.status,
      motivo: analise.motivo,
      dadosExtras: {
        ...dadosCnhExtrasRecebidos,
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
      consultarMultasComCache(cpfDigits, cnhUsadaConsulta || cnhPrincipal, process.env.TWOCAPTCHA_API_KEY)
        .then(() => {
          console.log(`[MULTAS] Prefetch concluído para ${cpfDigits}.`);
        })
        .catch((err) => {
          console.warn(`[MULTAS] Prefetch falhou para ${cpfDigits}: ${err?.message || err}`);
        });
    }

    if (
      (analise.temSuspensao || analise.temCassacao) &&
      dataNascimentoBr &&
      dataPrimeiraHabilitacaoBr &&
      process.env.TWOCAPTCHA_API_KEY
    ) {
      const tiposProcessoPrefetch = [];
      if (analise.temSuspensao) tiposProcessoPrefetch.push("suspensao");
      if (analise.temCassacao) tiposProcessoPrefetch.push("cassacao");

      tiposProcessoPrefetch.forEach((tipoProcessoPrefetch) => {
        consultarProcessoComCache(
          cpfDigits,
          cnhUsadaConsulta || cnhPrincipal,
          dataNascimentoBr,
          dataPrimeiraHabilitacaoBr,
          tipoProcessoPrefetch,
          process.env.TWOCAPTCHA_API_KEY
        )
          .then(() => {
            console.log(`[PROCESSO] Prefetch concluído para ${cpfDigits} (${tipoProcessoPrefetch}).`);
          })
          .catch((err) => {
            console.warn(
              `[PROCESSO] Prefetch falhou para ${cpfDigits} (${tipoProcessoPrefetch}): ${err?.message || err}`
            );
          });
      });
    }

    const payload = {
      ok: true,
      temProblemas: analise.temProblemas,
      temMultas: analise.temMultas || false,
      temSuspensao: analise.temSuspensao || false,
      temCassacao: analise.temCassacao || false,
      motivo: analise.motivo,
      status: analise.status,
      nome: nomeFinalCertidao || nomeCnhRecebido || null,
      numeroCertidao: analise.numeroCertidao || null,
      cnhConsultada: cnhUsadaConsulta || cnhPrincipal,
    };

    const statusCacheavel = ["OK", "MULTAS", "SUSPENSAO", "CASSACAO"].includes(payload.status);
    if (statusCacheavel) {
      const cacheItem = {
        createdAt: Date.now(),
        caseId,
        payload,
      };
      certidaoConsultaCache.set(consultaKey, cacheItem);

      const consultaKeyFinal = certidaoConsultaKey(cpfDigits, cnhUsadaConsulta || cnhPrincipal);
      if (consultaKeyFinal !== consultaKey) {
        certidaoConsultaCache.set(consultaKeyFinal, cacheItem);
      }
    } else {
      certidaoConsultaCache.delete(consultaKey);
    }

    return res.json({
      ...payload,
      caseId,
      pdfBase64: pdfBuffer.toString("base64"),
      cache: "miss",
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
    const { cpf, cnh, forceRefresh } = req.body;
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

    const resultado = await consultarMultasComCache(cpfDigits, cnhDigits, apiKey, {
      forceRefresh: Boolean(forceRefresh),
    });
    console.log(`[MULTAS] Consulta concluida para ${cpfDigits}. Quantidade extraida: ${resultado?.multas?.length || 0}. Cache=${resultado.fromCache ? "hit" : "miss"} ForceRefresh=${Boolean(forceRefresh)}`);

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
      : /DETRAN_MULTAS_DETALHE_NAO_ABERTO|DETRAN_MULTAS_DETALHE_VAZIO/i.test(mensagem)
      ? "Não foi possível abrir o detalhamento das infrações no portal do DETRAN-RJ. Tente novamente em instantes."
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
// ROTA: Consultar Processo Suspensão/Cassação
// =========================
router.post("/consultar-processo-cnh", async (req, res) => {
  try {
    const {
      cpf,
      cnh,
      dataNascimento,
      dataPrimeiraHabilitacao,
      tipo = "suspensao",
      forceRefresh,
    } = req.body || {};

    const cpfDigits = onlyDigits(cpf);
    const cnhDigits = onlyDigits(cnh);
    const dataNascimentoBr = normalizeDateBR(dataNascimento);
    const dataPrimeiraHabilitacaoBr = normalizeDateBR(dataPrimeiraHabilitacao);
    const tipoNormalizado = String(tipo || "suspensao").toLowerCase() === "cassacao" ? "cassacao" : "suspensao";
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
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dataNascimentoBr)) {
      return res.status(400).json({
        ok: false,
        error: "Data de nascimento é obrigatória no formato DD/MM/AAAA.",
      });
    }
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dataPrimeiraHabilitacaoBr)) {
      return res.status(400).json({
        ok: false,
        error: "Data da 1ª habilitação é obrigatória no formato DD/MM/AAAA.",
      });
    }

    const resultado = await consultarProcessoComCache(
      cpfDigits,
      cnhDigits,
      dataNascimentoBr,
      dataPrimeiraHabilitacaoBr,
      tipoNormalizado,
      apiKey,
      { forceRefresh: Boolean(forceRefresh) }
    );

    return res.json({
      ok: true,
      tipo: tipoNormalizado,
      condutor: resultado.condutor || null,
      processos: Array.isArray(resultado.processos) ? resultado.processos : [],
      mensagem: resultado.mensagem || null,
      cache: resultado.fromCache ? "hit" : "miss",
    });
  } catch (err) {
    console.error("Erro processo suspensão/cassação:", err);
    const mensagem = err?.message || "Erro ao consultar processo administrativo.";
    const indisponivel = isErroProcessoRetryable(mensagem);
    const mensagemPublica = /DETRAN_PROCESSO_OFFLINE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(
      mensagem
    )
      ? "Portal de acompanhamento de processo do DETRAN-RJ indisponível para consulta automática no momento. Tente novamente em alguns minutos."
      : /captcha|token nao retornado/i.test(
          String(mensagem)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
        )
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

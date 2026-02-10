// src/services/leadStore.js
// Sistema de armazenamento de leads para enriquecer base de clientes futuros.
// Armazena dados pessoais coletados em todas as entradas (manual, upload, câmera).
//
// Estratégia de persistência:
// 1. Memória (Map) - acesso rápido durante a sessão
// 2. Arquivo JSON em /tmp - sobrevive a restarts dentro do mesmo container
// 3. Google Cloud Storage (bucket) - persistência definitiva entre deploys
//
// Dados armazenados por lead:
// - CPF, CNH, nome (quando disponível via OCR ou certidão)
// - Origem dos dados (manual, upload, camera)
// - Status da certidão (NADA_CONSTA, RESTRICAO, DESCONHECIDO)
// - Data/hora da consulta
// - Dados extras extraídos da certidão (número, motivo)

import fs from "fs";
import path from "path";

// Armazenamento em memória
const leadsMap = new Map();

// Arquivo local para persistência dentro do container
const LEADS_FILE = "/tmp/leads_database.json";

/**
 * Carrega leads do arquivo JSON (se existir)
 */
function carregarLeadsDoArquivo() {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8"));
      if (Array.isArray(data)) {
        data.forEach((lead) => {
          if (lead.cpf) leadsMap.set(lead.cpf, lead);
        });
        console.log(`[LEADS] ${data.length} leads carregados do arquivo.`);
      }
    }
  } catch (e) {
    console.error("[LEADS] Erro ao carregar arquivo:", e.message);
  }
}

/**
 * Salva leads no arquivo JSON
 */
function salvarLeadsNoArquivo() {
  try {
    const leads = Array.from(leadsMap.values());
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8");
  } catch (e) {
    console.error("[LEADS] Erro ao salvar arquivo:", e.message);
  }
}

/**
 * Salva leads no Google Cloud Storage (persistência definitiva)
 */
async function salvarLeadsNoBucket() {
  try {
    const bucketName = process.env.LEADS_BUCKET || process.env.OCR_BUCKET;
    if (!bucketName) return; // Bucket não configurado, ignora silenciosamente

    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    const bucket = storage.bucket(bucketName);

    const leads = Array.from(leadsMap.values());
    const fileName = "leads/leads_database.json";

    await bucket.file(fileName).save(JSON.stringify(leads, null, 2), {
      contentType: "application/json",
      resumable: false,
    });

    console.log(`[LEADS] ${leads.length} leads salvos no bucket ${bucketName}.`);
  } catch (e) {
    console.error("[LEADS] Erro ao salvar no bucket:", e.message);
  }
}

/**
 * Carrega leads do Google Cloud Storage
 */
async function carregarLeadsDoBucket() {
  try {
    const bucketName = process.env.LEADS_BUCKET || process.env.OCR_BUCKET;
    if (!bucketName) return;

    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    const bucket = storage.bucket(bucketName);
    const fileName = "leads/leads_database.json";

    const [exists] = await bucket.file(fileName).exists();
    if (!exists) return;

    const [buf] = await bucket.file(fileName).download();
    const data = JSON.parse(buf.toString("utf-8"));

    if (Array.isArray(data)) {
      data.forEach((lead) => {
        if (lead.cpf && !leadsMap.has(lead.cpf)) {
          leadsMap.set(lead.cpf, lead);
        }
      });
      console.log(`[LEADS] ${data.length} leads carregados do bucket.`);
    }
  } catch (e) {
    console.error("[LEADS] Erro ao carregar do bucket:", e.message);
  }
}

/**
 * Registra ou atualiza um lead
 * @param {Object} dados - Dados do lead
 * @param {string} dados.cpf - CPF (obrigatório)
 * @param {string} [dados.cnh] - Número da CNH
 * @param {string} [dados.nome] - Nome completo
 * @param {string} [dados.origem] - Origem: "manual", "upload", "camera"
 * @param {string} [dados.status] - Status da certidão: "OK", "RESTRICAO", "DESCONHECIDO"
 * @param {string} [dados.motivo] - Motivo da restrição (se houver)
 * @param {Object} [dados.extras] - Dados extras (número certidão, etc.)
 */
export function registrarLead(dados) {
  if (!dados || !dados.cpf) {
    console.warn("[LEADS] Tentativa de registrar lead sem CPF.");
    return null;
  }

  const cpf = dados.cpf.replace(/\D/g, "");
  const agora = new Date().toISOString();

  // Verifica se já existe
  const existente = leadsMap.get(cpf) || {};

  const lead = {
    cpf,
    cnh: dados.cnh || existente.cnh || null,
    nome: dados.nome || existente.nome || null,
    telefone: dados.telefone || existente.telefone || null,
    email: dados.email || existente.email || null,
    origem: dados.origem || existente.origem || "manual",
    status: dados.status || existente.status || "DESCONHECIDO",
    motivo: dados.motivo || existente.motivo || null,
    extras: { ...(existente.extras || {}), ...(dados.extras || {}) },
    primeiraConsulta: existente.primeiraConsulta || agora,
    ultimaConsulta: agora,
    totalConsultas: (existente.totalConsultas || 0) + 1,
    historico: [
      ...(existente.historico || []),
      {
        data: agora,
        origem: dados.origem || "manual",
        status: dados.status || "DESCONHECIDO",
        motivo: dados.motivo || null,
      },
    ],
  };

  leadsMap.set(cpf, lead);

  // Salva em background (não bloqueia)
  salvarLeadsNoArquivo();
  salvarLeadsNoBucket().catch(() => {});

  console.log(
    `[LEADS] Lead ${lead.totalConsultas > 1 ? "atualizado" : "registrado"}: CPF=${cpf}, Nome=${lead.nome || "N/A"}, Status=${lead.status}`
  );

  return lead;
}

/**
 * Extrai dados pessoais do texto da certidão
 * Baseado no formato da certidão modelo do DETRAN-RJ
 */
export function extrairDadosDaCertidao(textoNormalizado) {
  const dados = {
    nome: null,
    cpf: null,
    numeroCertidao: null,
  };

  if (!textoNormalizado) return dados;

  // Extrair nome: vem depois de "QUE CONTRA:" e antes de ", VINCULADO"
  const nomeMatch = textoNormalizado.match(
    /QUE CONTRA[:\s]*\n?\s*([A-Z\s]+?)\s*,?\s*VINCULADO/
  );
  if (nomeMatch) {
    dados.nome = nomeMatch[1].trim();
  }

  // Extrair CPF do texto da certidão
  const cpfMatch = textoNormalizado.match(/CPF[:\s]*(\d{11})/);
  if (cpfMatch) {
    dados.cpf = cpfMatch[1];
  }

  // Extrair número da certidão
  const numMatch = textoNormalizado.match(/N[°º]?[:\s]*(\d{4}\.\d{6})/);
  if (numMatch) {
    dados.numeroCertidao = numMatch[1];
  }

  return dados;
}

/**
 * Busca um lead pelo CPF
 */
export function buscarLead(cpf) {
  if (!cpf) return null;
  return leadsMap.get(cpf.replace(/\D/g, "")) || null;
}

/**
 * Lista todos os leads
 */
export function listarLeads() {
  return Array.from(leadsMap.values()).sort(
    (a, b) => new Date(b.ultimaConsulta) - new Date(a.ultimaConsulta)
  );
}

/**
 * Retorna estatísticas dos leads
 */
export function estatisticasLeads() {
  const leads = Array.from(leadsMap.values());
  return {
    total: leads.length,
    comRestricao: leads.filter((l) => l.status === "RESTRICAO").length,
    nadaConsta: leads.filter((l) => l.status === "OK").length,
    desconhecido: leads.filter((l) => l.status === "DESCONHECIDO").length,
    porOrigem: {
      manual: leads.filter((l) => l.origem === "manual").length,
      upload: leads.filter((l) => l.origem === "upload").length,
      camera: leads.filter((l) => l.origem === "camera").length,
    },
  };
}

// Inicialização: carrega leads existentes
carregarLeadsDoArquivo();
carregarLeadsDoBucket().catch(() => {});

export default {
  registrarLead,
  extrairDadosDaCertidao,
  buscarLead,
  listarLeads,
  estatisticasLeads,
};

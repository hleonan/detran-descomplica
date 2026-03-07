import fs from "fs";

// ====================================================
// CONFIGURAÇÃO DO GOOGLE SHEETS
// ====================================================
const SHEET_URL = "https://script.google.com/macros/s/AKfycbzQ5n8Vi8SYLcVMMg43OzhOjAC8QnNWy0ZLHBsxgBAZYNXuNxSJ4WlB0kWpHiTxoYyq/exec"; 
const SHEET_COLUMNS = [
  "cpf",
  "cnh",
  "nome",
  "nomeCompleto",
  "status",
  "motivo",
  "origem",
  "dataNascimento",
  "dataPrimeiraHabilitacao",
  "validadeCnh",
  "categoriaCnh",
  "docIdentidade",
  "orgaoEmissor",
  "ufEmissor",
  "dataEmissaoCnh",
  "localEmissaoCnh",
  "ultimaConsulta",
];

// Armazenamento em memória (Backup rápido)
const leadsMap = new Map();
const LEADS_FILE = "/tmp/leads_database.json";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || "";
}

function isMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const text = normalizeText(value);
    if (!text) return false;
    const upper = text.toUpperCase();
    return !["DESCONHECIDO", "NAO IDENTIFICADO", "NÃO IDENTIFICADO", "-"].includes(upper);
  }
  return true;
}

function pickValue(newValue, previousValue, fallback = "") {
  if (isMeaningfulValue(newValue)) return typeof newValue === "string" ? normalizeText(newValue) : newValue;
  if (isMeaningfulValue(previousValue)) {
    return typeof previousValue === "string" ? normalizeText(previousValue) : previousValue;
  }
  return fallback;
}

function normalizeExtras(extras = {}) {
  const payload = {};
  for (const [key, value] of Object.entries(extras || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const text = normalizeText(value);
      if (!text) continue;
      payload[key] = text;
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

/**
 * Função principal: Salva o Lead (Memória + Arquivo + Google Sheets)
 */
export async function registrarLead(dados) {
  try {
    const cpf = onlyDigits(dados.cpf || "");
    const cnh = onlyDigits(dados.cnh || "");
    const chaveLead = cpf || `cnh_${cnh || "desconhecida"}`;
    const leadAnterior = leadsMap.get(chaveLead) || null;
    const dadosExtrasEntrada = normalizeExtras(dados.dadosExtras || dados.extras || {});

    const lead = {
      cpf: pickValue(cpf, leadAnterior?.cpf, "Desconhecido"),
      cnh: pickValue(cnh, leadAnterior?.cnh, "Desconhecido"),
      nome: pickValue(dados.nome, leadAnterior?.nome, "Não identificado"),
      status: pickValue(dados.status, leadAnterior?.status, "DESCONHECIDO"), // OK ou RESTRICAO
      motivo: pickValue(dados.motivo, leadAnterior?.motivo, ""),
      origem: pickValue(dados.origem, leadAnterior?.origem, "manual"), // manual, upload, camera
      dadosExtras: {
        ...(leadAnterior?.dadosExtras || {}),
        ...dadosExtrasEntrada,
      },
      ultimaConsulta: new Date().toISOString(),
    };

    // 1. Salva na Memória RAM (Sempre atualiza)
    leadsMap.set(chaveLead, lead);

    // 2. Salva no Arquivo Temporário (Sempre atualiza)
    salvarLeadsNoArquivo();

    // 3. ENVIA PARA O GOOGLE SHEETS (COM FILTRO DE "PACIÊNCIA")
    enviarParaGoogleSheets(lead).catch(err => console.error("[LEADS] Erro ao enviar para Sheet:", err));

    console.log(`[LEADS] Lead registrado: ${lead.cpf} (${lead.status})`);
    return lead;

  } catch (error) {
    console.error("[LEADS] Erro crítico ao registrar lead:", error);
    return null;
  }
}

/**
 * Envia os dados para a planilha via Webhook
 */
async function enviarParaGoogleSheets(lead) {
  // Verificação de segurança da URL
  if (!SHEET_URL || SHEET_URL.includes("COLE_SUA_URL")) return;

  // === O FILTRO MÁGICO ===
  // Só envia para a planilha se o status for definitivo.
  // Ignora leads que acabaram de chegar ("DESCONHECIDO") ou estão processando.
  const statusIgnorados = ["DESCONHECIDO", "PROCESSANDO", "AGUARDANDO"];
  
  if (!lead.status || statusIgnorados.includes(lead.status)) {
      // Se quiser ver no log que ele ignorou, descomente a linha abaixo:
      // console.log("[LEADS] Status preliminar ignorado no Sheets:", lead.status);
      return; 
  }

  try {
    const extras = lead.dadosExtras || {};
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        _sheetColumns: SHEET_COLUMNS,
        colunasEsperadas: SHEET_COLUMNS,
        cpf: lead.cpf,
        cnh: lead.cnh,
        nome: lead.nome,
        nomeCompleto: lead.nome,
        nome_completo: lead.nome,
        status: lead.status, // Agora só vai chegar "OK", "RESTRICAO" ou "ERRO"
        motivo: lead.motivo,
        origem: lead.origem,
        dataNascimento: extras.dataNascimento || "",
        data_nascimento: extras.dataNascimento || "",
        dataPrimeiraHabilitacao: extras.dataPrimeiraHabilitacao || "",
        primeira_habilitacao: extras.dataPrimeiraHabilitacao || "",
        validadeCnh: extras.validadeCnh || "",
        categoriaCnh: extras.categoriaCnh || "",
        docIdentidade: extras.docIdentidade || "",
        orgaoEmissor: extras.orgaoEmissor || "",
        ufEmissor: extras.ufEmissor || "",
        dataEmissaoCnh: extras.dataEmissaoCnh || "",
        localEmissaoCnh: extras.localEmissaoCnh || "",
        dadosCnhJson: JSON.stringify(extras),
        ultimaConsulta: lead.ultimaConsulta,
      }),
      redirect: "follow"
    });
    console.log("[LEADS] ✅ Enviado para o Google Sheets (Status Final).");
  } catch (error) {
    console.error("[LEADS] Falha na conexão com Google Sheets:", error);
  }
}

// --- Funções Auxiliares ---

function salvarLeadsNoArquivo() {
  try {
    const dados = Array.from(leadsMap.values());
    fs.writeFileSync(LEADS_FILE, JSON.stringify(dados, null, 2));
  } catch (e) {
    console.error("[LEADS] Erro ao salvar arquivo local:", e.message);
  }
}

export function buscarLead(cpf) {
  if (!cpf) return null;
  const cpfDigits = onlyDigits(cpf);
  if (cpfDigits && leadsMap.has(cpfDigits)) return leadsMap.get(cpfDigits) || null;
  return Array.from(leadsMap.values()).find((lead) => onlyDigits(lead?.cpf) === cpfDigits) || null;
}

export function listarLeads() {
  return Array.from(leadsMap.values()).sort(
    (a, b) => new Date(b.ultimaConsulta) - new Date(a.ultimaConsulta)
  );
}

export function estatisticasLeads() {
  const leads = Array.from(leadsMap.values());
  return {
    total: leads.length,
    comRestricao: leads.filter((l) => l.status === "RESTRICAO").length,
    nadaConsta: leads.filter((l) => l.status === "OK").length,
  };
}

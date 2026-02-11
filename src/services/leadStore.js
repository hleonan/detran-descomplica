import fs from "fs";

// ====================================================
// CONFIGURAÇÃO DO GOOGLE SHEETS
// ====================================================
// A URL agora está correta dentro das aspas abaixo:
const SHEET_URL = "https://script.google.com/macros/s/AKfycbwsDWu8AgHvGUp5UgdbL9JCOTEPUxjThba1LLKGo8KE_TyJgqVYB5xA8A8Zy1JtNJcF/exec"; 

// Armazenamento em memória (Backup rápido)
const leadsMap = new Map();
const LEADS_FILE = "/tmp/leads_database.json";

/**
 * Função principal: Salva o Lead (Memória + Arquivo + Google Sheets)
 */
export async function registrarLead(dados) {
  try {
    const lead = {
      cpf: dados.cpf || "Desconhecido",
      cnh: dados.cnh || "Desconhecido",
      nome: dados.nome || "Não identificado",
      status: dados.status || "DESCONHECIDO", // OK ou RESTRICAO
      motivo: dados.motivo || "",
      origem: dados.origem || "manual", // manual, upload, camera
      dadosExtras: dados.dadosExtras || {},
      ultimaConsulta: new Date().toISOString(),
    };

    // 1. Salva na Memória RAM
    leadsMap.set(lead.cpf, lead);

    // 2. Salva no Arquivo Temporário (Backup local)
    salvarLeadsNoArquivo();

    // 3. ENVIA PARA O GOOGLE SHEETS (Assíncrono - não trava o site)
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
  // Verificação de segurança
  if (!SHEET_URL || SHEET_URL.includes("COLE_SUA_URL")) {
    console.warn("[LEADS] URL do Google Sheets não configurada corretamente.");
    return;
  }

  try {
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cpf: lead.cpf,
        cnh: lead.cnh,
        status: lead.status,
        motivo: lead.motivo,
        origem: lead.origem
      }),
      redirect: "follow" // Importante para Apps Script
    });
    console.log("[LEADS] Enviado para o Google Sheets com sucesso.");
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
  return leadsMap.get(cpf.replace(/\D/g, "")) || null;
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

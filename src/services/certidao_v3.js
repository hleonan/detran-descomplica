// src/services/certidao_v3.js
// ============================================================
// Despachante Virtual RJ - Automação de Certidão DETRAN
// ============================================================
// Estratégia: Acesso Direto (rápido) + Trava de Segurança
// - Navega direto na URL do iframe do DETRAN
// - Resolve o reCAPTCHA v2 via 2Captcha
// - Após clicar "Consultar", valida o texto da tela:
//   * Se contiver erro → lança DETRAN_FAIL (Frontend mostra WhatsApp)
//   * Se sucesso → extrai dados do HTML + gera PDF via screenshot
// - Retorna { pdfBuffer, analise } para o api.js
// ============================================================

import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

// URL direta do formulário de certidão (iframe do DETRAN)
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

// Frases que indicam ERRO na resposta do DETRAN
const FRASES_ERRO = [
  "DADOS INFORMADOS INVÁLIDOS",
  "DADOS INFORMADOS NÃO CONFEREM",
  "NÃO CONFEREM",
  "CAPTCHA INCORRETO",
  "ERRO NA CONSULTA",
  "CÓDIGO DE VERIFICAÇÃO INCORRETO",
  "INFORME O CÓDIGO",
  "PREENCHA TODOS OS CAMPOS",
];

// Frases que indicam SUCESSO / Certidão válida
const FRASES_SUCESSO = [
  "NADA CONSTA",
  "CERTIDÃO",
  "CERTIFICAMOS",
];

// Frases que indicam RESTRIÇÃO
const FRASES_RESTRICAO = [
  "CONSTA",
  "PROCESSO",
  "SUSPENSÃO",
  "SUSPENSAO",
  "CASSAÇÃO",
  "CASSACAO",
  "PENALIDADE",
  "BLOQUEIO",
];

/**
 * Resolve o reCAPTCHA v2 usando a API do 2Captcha.
 * Retorna o token de resposta ou lança erro.
 */
async function resolverCaptcha2Captcha(twocaptchaKey, sitekey, pageUrl) {
  console.log("[CAPTCHA] Enviando para 2Captcha...");

  const inRes = await fetch(
    `http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${pageUrl}&json=1`
  );
  const inData = await inRes.json();

  if (!inData || inData.status !== 1) {
    throw new Error(`2Captcha in.php erro: ${inData?.request || "resposta inválida"}`);
  }

  const requestId = inData.request;
  console.log(`[CAPTCHA] Request ID: ${requestId}. Aguardando resolução...`);

  const startTime = Date.now();
  const MAX_WAIT = 120000; // 2 minutos

  while (Date.now() - startTime < MAX_WAIT) {
    // Espera 5 segundos entre cada tentativa
    await new Promise((r) => setTimeout(r, 5000));

    const resResp = await fetch(
      `http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${requestId}&json=1`
    );
    const resData = await resResp.json();

    if (resData?.status === 1) {
      console.log("[CAPTCHA] Token obtido com sucesso!");
      return resData.request;
    }

    const msg = String(resData?.request || "");
    if (msg !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha res.php erro: ${msg}`);
    }
  }

  throw new Error("2Captcha timeout (demorou > 2 min)");
}

/**
 * Extrai dados da certidão a partir do texto visível na tela.
 * Retorna um objeto de análise com status, motivo, nome, etc.
 */
function analisarTextoCertidao(textoTela) {
  const textoUpper = textoTela.toUpperCase();

  // Dados padrão
  const analise = {
    status: "DESCONHECIDO",
    motivo: "Não foi possível classificar a certidão",
    temProblemas: false,
    nome: null,
    numeroCertidao: null,
    dados: {},
  };

  // 1. Tenta extrair o NOME do motorista
  //    Padrão comum: "Nome: FULANO DE TAL" ou "Condutor(a): FULANO"
  const nomePatterns = [
    /(?:Nome|Condutor(?:\(a\))?|Habilitado)\s*[:\-]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]+)/i,
    /(?:CERTIFICAMOS QUE|CERTIFICA QUE)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]+?)(?:\s*,|\s+CPF|\s+INSCRIT)/i,
  ];
  for (const pattern of nomePatterns) {
    const match = textoTela.match(pattern);
    if (match && match[1]) {
      analise.nome = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  // 2. Tenta extrair o número da certidão
  const certidaoMatch = textoTela.match(
    /(?:Certid[aã]o|Certificado)\s*(?:n[°ºo]?|Número)?\s*[:\-]?\s*(\d[\d.\-\/]+)/i
  );
  if (certidaoMatch) {
    analise.numeroCertidao = certidaoMatch[1].trim();
  }

  // 3. Classifica o status
  const temNadaConsta = textoUpper.includes("NADA CONSTA");
  const temCertidao = FRASES_SUCESSO.some((f) => textoUpper.includes(f));
  const temRestricao = FRASES_RESTRICAO.some((f) => textoUpper.includes(f));

  if (temNadaConsta && !temRestricao) {
    // NADA CONSTA puro
    analise.status = "OK";
    analise.motivo = "Certidão de Nada Consta emitida com sucesso.";
    analise.temProblemas = false;
  } else if (temRestricao) {
    // Tem restrição
    analise.status = "RESTRICAO";
    analise.temProblemas = true;

    // Detalha o motivo
    if (textoUpper.includes("SUSPENSÃO") || textoUpper.includes("SUSPENSAO")) {
      analise.motivo = "Processo de suspensão do direito de dirigir identificado.";
    } else if (textoUpper.includes("CASSAÇÃO") || textoUpper.includes("CASSACAO")) {
      analise.motivo = "Processo de cassação da CNH identificado.";
    } else if (textoUpper.includes("BLOQUEIO")) {
      analise.motivo = "Bloqueio identificado no prontuário.";
    } else if (textoUpper.includes("PROCESSO")) {
      analise.motivo = "Processo administrativo em andamento.";
    } else {
      analise.motivo = "Restrição identificada na certidão.";
    }
  } else if (temCertidao) {
    // Tem "CERTIDÃO" mas sem "NADA CONSTA" explícito — pode ser OK
    analise.status = "OK";
    analise.motivo = "Certidão emitida. Sem restrições aparentes.";
    analise.temProblemas = false;
  }

  return analise;
}

/**
 * Função principal: Emite a certidão do DETRAN-RJ.
 *
 * @param {string} cpf - CPF do motorista (só dígitos ou formatado)
 * @param {string} cnh - Número da CNH (só dígitos ou formatado)
 * @returns {Promise<{pdfBuffer: Buffer, analise: Object}>}
 */
export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] ========================================");
  console.log("[DETRAN] Iniciando automação (Acesso Direto v3)");
  console.log("[DETRAN] ========================================");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  // Limpeza dos dados
  const cpfLimpo = cpf.replace(/\D/g, "");
  const cnhLimpo = cnh.replace(/\D/g, "");

  if (cpfLimpo.length !== 11) throw new Error("CPF inválido (deve ter 11 dígitos)");
  if (cnhLimpo.length < 9) throw new Error("CNH inválida (deve ter pelo menos 9 dígitos)");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY não configurada no servidor");

  let browser;
  try {
    // ============================================================
    // 1. INICIAR NAVEGADOR
    // ============================================================
    console.log("[DETRAN] Iniciando Chromium headless...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // ============================================================
    // 2. ACESSO DIRETO À URL DO FORMULÁRIO
    // ============================================================
    console.log("[DETRAN] Acessando URL direta do formulário...");
    await page.goto(CERTIDAO_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Espera o campo CPF aparecer (prova de que a página carregou)
    console.log("[DETRAN] Aguardando formulário carregar...");
    await page.waitForSelector("#CertidaoCpf", {
      state: "visible",
      timeout: 30000,
    });
    console.log("[DETRAN] Formulário carregado com sucesso!");

    // ============================================================
    // 3. PREENCHER FORMULÁRIO
    // ============================================================
    console.log("[DETRAN] Preenchendo CPF e CNH...");
    await page.fill("#CertidaoCpf", cpfLimpo);
    await page.fill("#CertidaoCnh", cnhLimpo);
    console.log("[DETRAN] Campos preenchidos!");

    // ============================================================
    // 4. RESOLVER CAPTCHA
    // ============================================================
    console.log("[DETRAN] Procurando reCAPTCHA...");
    let sitekey = null;

    // Método 1: Buscar no iframe do reCAPTCHA
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      const src = await recaptchaFrame.getAttribute("src");
      if (src) {
        const params = new URLSearchParams(src.split("?")[1] || "");
        sitekey = params.get("k");
      }
    }

    // Método 2: Buscar no atributo data-sitekey
    if (!sitekey) {
      sitekey = await page.evaluate(() => {
        const el = document.querySelector(".g-recaptcha");
        return el ? el.getAttribute("data-sitekey") : null;
      }).catch(() => null);
    }

    // Método 3: Buscar em frames internos
    if (!sitekey) {
      for (const frame of page.frames()) {
        sitekey = await frame.evaluate(() => {
          const el = document.querySelector(".g-recaptcha");
          return el ? el.getAttribute("data-sitekey") : null;
        }).catch(() => null);
        if (sitekey) break;
      }
    }

    if (!sitekey) {
      console.error("[DETRAN] reCAPTCHA sitekey não encontrada!");
      throw new Error("DETRAN_FAIL: Não foi possível encontrar o reCAPTCHA na página.");
    }

    console.log(`[DETRAN] Sitekey encontrada: ${sitekey.substring(0, 20)}...`);

    // Resolver via 2Captcha
    const token = await resolverCaptcha2Captcha(twocaptchaKey, sitekey, CERTIDAO_URL);

    // Injetar o token na página
    console.log("[DETRAN] Injetando token do reCAPTCHA...");
    await page.evaluate((t) => {
      // Preenche o textarea de resposta
      const responseArea =
        document.querySelector('textarea[name="g-recaptcha-response"]') ||
        document.getElementById("g-recaptcha-response");
      if (responseArea) {
        responseArea.style.display = "block";
        responseArea.value = t;
        responseArea.innerHTML = t;
        responseArea.dispatchEvent(new Event("input", { bubbles: true }));
        responseArea.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // Tenta chamar callbacks do reCAPTCHA (se existirem)
      try {
        if (window.___grecaptcha_cfg) {
          Object.values(window.___grecaptcha_cfg.clients).forEach((client) => {
            Object.values(client).forEach((component) => {
              if (component && typeof component === "object") {
                Object.values(component).forEach((item) => {
                  if (item && item.callback && typeof item.callback === "function") {
                    item.callback(t);
                  }
                });
              }
            });
          });
        }
      } catch (e) {
        // Ignora erros de callback — o token já foi injetado
      }
    }, token);
    console.log("[DETRAN] Token injetado com sucesso!");

    // ============================================================
    // 5. CLICAR EM "CONSULTAR"
    // ============================================================
    console.log("[DETRAN] Clicando em Pesquisar...");
    await page.click("#btPesquisar");

    // Espera a resposta do servidor
    await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {
      console.log("[DETRAN] NetworkIdle timeout (normal em sites lentos)");
    });

    // Pequeno respiro para renderização completa
    await page.waitForTimeout(2000);

    // ============================================================
    // 6. TRAVA DE SEGURANÇA — Validação do Resultado
    // ============================================================
    console.log("[DETRAN] Validando resultado da consulta...");
    const textoTela = await page.evaluate(() => document.body.innerText);
    const textoUpper = textoTela.toUpperCase();

    // Log do texto para debug
    console.log(`[DETRAN] Texto da tela (primeiros 200 chars): ${textoTela.substring(0, 200)}...`);

    // Verifica se a tela contém mensagens de ERRO
    const erroEncontrado = FRASES_ERRO.find((frase) => textoUpper.includes(frase));

    if (erroEncontrado) {
      console.error(`[DETRAN] ERRO DETECTADO NA TELA: "${erroEncontrado}"`);
      console.error("[DETRAN] NÃO vou gerar PDF de tela de erro.");

      // Registra como erro no lead
      throw new Error(
        "DETRAN_FAIL: O site do DETRAN recusou os dados informados. Verifique CPF e CNH."
      );
    }

    // Verifica se a tela parece ter conteúdo válido de certidão
    const temConteudoValido = FRASES_SUCESSO.some((f) => textoUpper.includes(f));

    if (!temConteudoValido) {
      // A tela não tem erro explícito, mas também não tem conteúdo de certidão
      // Pode ser uma página em branco ou com conteúdo inesperado
      console.warn("[DETRAN] Tela sem conteúdo reconhecível de certidão.");
      console.warn(`[DETRAN] Texto completo: ${textoTela.substring(0, 500)}`);

      // Verifica se pelo menos tem algo que pareça um resultado
      const temAlgumResultado =
        textoUpper.includes("CPF") &&
        textoUpper.includes("CNH") &&
        textoTela.length > 200;

      if (!temAlgumResultado) {
        throw new Error(
          "DETRAN_FAIL: O site não retornou um resultado válido. Tente novamente."
        );
      }
    }

    console.log("[DETRAN] Resultado validado! Tela contém certidão.");

    // ============================================================
    // 7. ANÁLISE DOS DADOS DA CERTIDÃO (do HTML, antes do PDF)
    // ============================================================
    console.log("[DETRAN] Analisando dados da certidão...");
    const analise = analisarTextoCertidao(textoTela);
    console.log(`[DETRAN] Status: ${analise.status} | Motivo: ${analise.motivo}`);
    if (analise.nome) console.log(`[DETRAN] Nome: ${analise.nome}`);
    if (analise.numeroCertidao) console.log(`[DETRAN] Nº Certidão: ${analise.numeroCertidao}`);

    // ============================================================
    // 8. GERAÇÃO DO PDF (via Screenshot — renderiza perfeitamente)
    // ============================================================
    console.log("[DETRAN] Gerando PDF visual (screenshot)...");
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });

    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(screenshot);

    // Cria página do tamanho da imagem
    const pagePdf = pdfDoc.addPage([pngImage.width, pngImage.height]);
    pagePdf.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: pngImage.width,
      height: pngImage.height,
    });

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    console.log(`[DETRAN] PDF gerado com sucesso! (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
    console.log("[DETRAN] ========================================");
    console.log("[DETRAN] Automação concluída com sucesso!");
    console.log("[DETRAN] ========================================");

    // ============================================================
    // 9. RETORNO — Objeto completo para o api.js
    // ============================================================
    return {
      pdfBuffer,
      analise,
    };

  } catch (error) {
    console.error(`[DETRAN] ERRO: ${error.message}`);

    // Se o erro já é um DETRAN_FAIL, propaga direto
    if (error.message.includes("DETRAN_FAIL")) {
      throw error;
    }

    // Para outros erros (timeout, crash, etc.), encapsula como DETRAN_FAIL
    throw new Error(`DETRAN_FAIL: ${error.message}`);

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log("[DETRAN] Navegador fechado.");
    }
  }
}

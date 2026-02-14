// src/services/certidao_v3.js
// ============================================================
// Despachante Virtual RJ - Automação de Certidão DETRAN
// ============================================================
// Estratégia: Acesso Direto + Extrato Completo + 5 Cenários
//
// Fluxo:
// 1. Acessa URL direta do formulário (rápido)
// 2. Preenche CPF/CNH + resolve reCAPTCHA via 2Captcha
// 3. Clica "Consultar" → valida resultado (trava DETRAN_FAIL)
// 4. Clica "EMITIR EXTRATO COMPLETO" (página 2)
// 5. Classifica em 5 cenários: OK, MULTAS, SUSPENSAO, CASSACAO, DETRAN_FAIL
// 6. Gera PDF via screenshot (ambas as páginas)
// 7. Retorna { pdfBuffer, analise } para o api.js
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

/**
 * Resolve o reCAPTCHA v2 usando a API do 2Captcha.
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
 * Classifica a situação da CNH em 5 cenários com base no texto do extrato.
 *
 * Cenários:
 *   "OK"        → Nada consta
 *   "MULTAS"    → Só multas (sem suspensão/cassação)
 *   "SUSPENSAO" → Multas + processo de suspensão
 *   "CASSACAO"  → Multas + suspensão + cassação
 *
 * Retorna objeto analise com: status, motivo, temProblemas, temMultas,
 * temSuspensao, temCassacao, nome, numeroCertidao
 */
function classificarCertidao(textoTela) {
  const textoUpper = textoTela.toUpperCase();

  const analise = {
    status: "OK",
    motivo: "",
    temProblemas: false,
    temMultas: false,
    temSuspensao: false,
    temCassacao: false,
    nome: null,
    numeroCertidao: null,
    dados: {},
  };

  // ── Extrair NOME do motorista ──
  const nomePatterns = [
    /(?:Nome|Condutor(?:\(a\))?|Habilitado)\s*[:\-]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]+)/i,
    /(?:CERTIFICAMOS QUE|CERTIFICA QUE)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]+?)(?:\s*,|\s+CPF|\s+INSCRIT)/i,
    /(?:Condutor|Nome)\s*[:\-]?\s*\n?\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]{3,})/i,
  ];
  for (const pattern of nomePatterns) {
    const match = textoTela.match(pattern);
    if (match && match[1]) {
      analise.nome = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  // ── Extrair número da certidão ──
  const certidaoMatch = textoTela.match(
    /(?:Certid[aã]o|Certificado)\s*(?:n[°ºo]?|N[úu]mero)?\s*[:\-]?\s*(\d[\d.\-\/]+)/i
  );
  if (certidaoMatch) {
    analise.numeroCertidao = certidaoMatch[1].trim();
  }

  // ── Detectar ocorrências ──
  // Multas / Infrações
  const temMultas =
    textoUpper.includes("MULTA") ||
    textoUpper.includes("INFRAÇÃO") ||
    textoUpper.includes("INFRACAO") ||
    textoUpper.includes("AUTO DE INFRAÇÃO") ||
    textoUpper.includes("AUTO DE INFRACAO") ||
    textoUpper.includes("PENALIDADE") ||
    textoUpper.includes("PONTUAÇÃO") ||
    textoUpper.includes("PONTUACAO") ||
    textoUpper.includes("PONTOS");

  // Suspensão
  const temSuspensao =
    textoUpper.includes("SUSPENSÃO") ||
    textoUpper.includes("SUSPENSAO") ||
    textoUpper.includes("PROCESSO DE SUSPENS") ||
    textoUpper.includes("DIREITO DE DIRIGIR SUSPENSO") ||
    textoUpper.includes("SUSPENDER O DIREITO");

  // Cassação
  const temCassacao =
    textoUpper.includes("CASSAÇÃO") ||
    textoUpper.includes("CASSACAO") ||
    textoUpper.includes("PROCESSO DE CASSAÇ") ||
    textoUpper.includes("PROCESSO DE CASSAC") ||
    textoUpper.includes("CASSAR") ||
    textoUpper.includes("CASSADA");

  // Nada Consta
  const temNadaConsta = textoUpper.includes("NADA CONSTA");

  analise.temMultas = temMultas;
  analise.temSuspensao = temSuspensao;
  analise.temCassacao = temCassacao;

  // ── Classificar cenário (do mais grave para o menos grave) ──
  if (temCassacao) {
    // Cenário 4: Multas + Suspensão + Cassação
    analise.status = "CASSACAO";
    analise.temProblemas = true;
    analise.motivo =
      "Sua CNH está em risco de cassação. Isso significa que você pode perder sua habilitação e precisar iniciar um novo processo do zero. Nossa equipe pode te ajudar a reverter essa situação.";
  } else if (temSuspensao) {
    // Cenário 3: Multas + Suspensão
    analise.status = "SUSPENSAO";
    analise.temProblemas = true;
    analise.motivo =
      "Sua CNH está em risco iminente de suspensão. Identificamos um processo de suspensão do direito de dirigir. Nossa equipe pode te ajudar a resolver antes que seja tarde.";
  } else if (temMultas && !temNadaConsta) {
    // Cenário 2: Só multas
    analise.status = "MULTAS";
    analise.temProblemas = true;
    analise.motivo =
      "Identificamos multas no seu prontuário. Se não forem tratadas, podem gerar um processo de suspensão da sua CNH. Nossa equipe pode te ajudar a resolver.";
  } else if (temNadaConsta) {
    // Cenário 5: Nada Consta
    analise.status = "OK";
    analise.temProblemas = false;
    analise.motivo =
      "Parabéns! Sua CNH está limpa, sem nenhuma ocorrência registrada no DETRAN.";
  } else {
    // Fallback: se não identificou nenhum padrão claro
    // Verifica se tem algum conteúdo de certidão
    const temCertidao =
      textoUpper.includes("CERTIDÃO") ||
      textoUpper.includes("CERTIFICAMOS") ||
      textoUpper.includes("CERTIDAO");

    if (temCertidao) {
      analise.status = "OK";
      analise.temProblemas = false;
      analise.motivo = "Certidão emitida. Sem restrições aparentes.";
    } else {
      analise.status = "OK";
      analise.temProblemas = false;
      analise.motivo = "Consulta realizada com sucesso.";
    }
  }

  console.log(`[CLASSIFICAÇÃO] Status: ${analise.status}`);
  console.log(`[CLASSIFICAÇÃO] Multas: ${temMultas} | Suspensão: ${temSuspensao} | Cassação: ${temCassacao} | Nada Consta: ${temNadaConsta}`);

  return analise;
}

/**
 * Função principal: Emite a certidão do DETRAN-RJ.
 *
 * @param {string} cpf - CPF do motorista
 * @param {string} cnh - Número da CNH
 * @returns {Promise<{pdfBuffer: Buffer, analise: Object}>}
 */
export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] ========================================");
  console.log("[DETRAN] Iniciando automação (v3.1 - Extrato Completo)");
  console.log("[DETRAN] ========================================");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

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

    await page.waitForSelector("#CertidaoCpf", {
      state: "visible",
      timeout: 30000,
    });
    console.log("[DETRAN] Formulário carregado!");

    // ============================================================
    // 3. PREENCHER FORMULÁRIO
    // ============================================================
    console.log("[DETRAN] Preenchendo CPF e CNH...");
    await page.fill("#CertidaoCpf", cpfLimpo);
    await page.fill("#CertidaoCnh", cnhLimpo);

    // ============================================================
    // 4. RESOLVER CAPTCHA
    // ============================================================
    console.log("[DETRAN] Procurando reCAPTCHA...");
    let sitekey = null;

    // Método 1: iframe do reCAPTCHA
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      const src = await recaptchaFrame.getAttribute("src");
      if (src) {
        const params = new URLSearchParams(src.split("?")[1] || "");
        sitekey = params.get("k");
      }
    }

    // Método 2: atributo data-sitekey
    if (!sitekey) {
      sitekey = await page
        .evaluate(() => {
          const el = document.querySelector(".g-recaptcha");
          return el ? el.getAttribute("data-sitekey") : null;
        })
        .catch(() => null);
    }

    // Método 3: frames internos
    if (!sitekey) {
      for (const frame of page.frames()) {
        sitekey = await frame
          .evaluate(() => {
            const el = document.querySelector(".g-recaptcha");
            return el ? el.getAttribute("data-sitekey") : null;
          })
          .catch(() => null);
        if (sitekey) break;
      }
    }

    if (!sitekey) {
      throw new Error("DETRAN_FAIL: Não foi possível encontrar o reCAPTCHA na página.");
    }

    console.log(`[DETRAN] Sitekey: ${sitekey.substring(0, 20)}...`);
    const token = await resolverCaptcha2Captcha(twocaptchaKey, sitekey, CERTIDAO_URL);

    // Injetar token
    console.log("[DETRAN] Injetando token do reCAPTCHA...");
    await page.evaluate((t) => {
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
        // Ignora
      }
    }, token);
    console.log("[DETRAN] Token injetado!");

    // ============================================================
    // 5. CLICAR EM "CONSULTAR"
    // ============================================================
    console.log("[DETRAN] Clicando em Consultar...");
    await page.click("#btPesquisar");

    await page.waitForLoadState("networkidle", { timeout: 45000 }).catch(() => {
      console.log("[DETRAN] NetworkIdle timeout (normal em sites lentos)");
    });
    await page.waitForTimeout(2000);

    // ============================================================
    // 6. TRAVA DE SEGURANÇA — Validação do Resultado (Página 1)
    // ============================================================
    console.log("[DETRAN] Validando resultado da consulta (Página 1)...");
    const textoPagina1 = await page.evaluate(() => document.body.innerText);
    const textoUpperP1 = textoPagina1.toUpperCase();

    console.log(`[DETRAN] Texto P1 (200 chars): ${textoPagina1.substring(0, 200)}...`);

    // Verifica ERRO
    const erroEncontrado = FRASES_ERRO.find((frase) => textoUpperP1.includes(frase));
    if (erroEncontrado) {
      console.error(`[DETRAN] ERRO NA TELA: "${erroEncontrado}"`);
      throw new Error("DETRAN_FAIL: O site do DETRAN recusou os dados informados. Verifique CPF e CNH.");
    }

    // Verifica se tem conteúdo mínimo válido
    const temConteudoMinimo =
      textoUpperP1.includes("CERTIDÃO") ||
      textoUpperP1.includes("CERTIDAO") ||
      textoUpperP1.includes("CERTIFICAMOS") ||
      textoUpperP1.includes("NADA CONSTA") ||
      textoUpperP1.includes("CONSTA") ||
      textoUpperP1.includes("EXTRATO") ||
      textoUpperP1.includes("CONDUTOR") ||
      (textoUpperP1.includes("CPF") && textoPagina1.length > 200);

    if (!temConteudoMinimo) {
      console.warn("[DETRAN] Página sem conteúdo reconhecível.");
      throw new Error("DETRAN_FAIL: O site não retornou um resultado válido. Tente novamente.");
    }

    console.log("[DETRAN] Página 1 validada!");

    // ── Screenshot da Página 1 ──
    console.log("[DETRAN] Capturando screenshot da Página 1...");
    const screenshotPag1 = await page.screenshot({ fullPage: true, type: "png" });

    // ============================================================
    // 7. CLICAR NO "EXTRATO COMPLETO" (Página 2)
    // ============================================================
    console.log("[DETRAN] Procurando link do Extrato Completo...");
    let clicouExtrato = false;
    let screenshotPag2 = null;
    let textoExtrato = "";

    // Tenta encontrar o link/botão de extrato completo
    // Pode ser um <a>, <button>, ou <input> com texto variado
    const seletoresExtrato = [
      'a:has-text("EXTRATO COMPLETO")',
      'a:has-text("EMITIR EXTRATO")',
      'a:has-text("CLIQUE AQUI")',
      'a:has-text("extrato completo")',
      'a:has-text("emitir extrato")',
      'a:has-text("clique aqui")',
      'button:has-text("EXTRATO")',
      'input[value*="EXTRATO" i]',
      'a[href*="extrato" i]',
    ];

    for (const seletor of seletoresExtrato) {
      try {
        const elemento = await page.$(seletor);
        if (elemento) {
          const isVisible = await elemento.isVisible();
          if (isVisible) {
            console.log(`[DETRAN] Link de extrato encontrado: ${seletor}`);
            await elemento.click();
            clicouExtrato = true;
            break;
          }
        }
      } catch (e) {
        // Seletor não encontrou, tenta o próximo
      }
    }

    // Fallback: busca por texto no innerText de todos os links
    if (!clicouExtrato) {
      console.log("[DETRAN] Tentando fallback: busca por texto nos links...");
      clicouExtrato = await page.evaluate(() => {
        const links = document.querySelectorAll("a, button, span, div");
        for (const el of links) {
          const txt = (el.innerText || el.textContent || "").toUpperCase();
          if (
            txt.includes("EXTRATO COMPLETO") ||
            txt.includes("EMITIR EXTRATO") ||
            txt.includes("CLIQUE AQUI PARA EMITIR")
          ) {
            el.click();
            return true;
          }
        }
        return false;
      });
    }

    if (clicouExtrato) {
      console.log("[DETRAN] Clicou no Extrato Completo! Aguardando Página 2...");

      // Espera a página 2 carregar
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {
        console.log("[DETRAN] NetworkIdle timeout na Página 2");
      });
      await page.waitForTimeout(2000);

      // Captura texto e screenshot da Página 2
      textoExtrato = await page.evaluate(() => document.body.innerText);
      console.log(`[DETRAN] Texto Extrato (200 chars): ${textoExtrato.substring(0, 200)}...`);

      screenshotPag2 = await page.screenshot({ fullPage: true, type: "png" });
      console.log("[DETRAN] Screenshot da Página 2 capturado!");
    } else {
      console.log("[DETRAN] Link de extrato NÃO encontrado. Usando apenas Página 1.");
    }

    // ============================================================
    // 8. CLASSIFICAR A SITUAÇÃO (5 Cenários)
    // ============================================================
    // Usa o texto mais completo disponível (Página 2 se existir, senão Página 1)
    const textoParaAnalise = textoExtrato.length > 100 ? textoExtrato : textoPagina1;
    // Combina ambos os textos para não perder informação
    const textoCompleto = textoPagina1 + "\n" + textoExtrato;

    console.log("[DETRAN] Classificando situação da CNH...");
    const analise = classificarCertidao(textoCompleto);

    console.log(`[DETRAN] ═══ RESULTADO FINAL ═══`);
    console.log(`[DETRAN] Status: ${analise.status}`);
    console.log(`[DETRAN] Motivo: ${analise.motivo}`);
    console.log(`[DETRAN] Multas: ${analise.temMultas} | Suspensão: ${analise.temSuspensao} | Cassação: ${analise.temCassacao}`);
    if (analise.nome) console.log(`[DETRAN] Nome: ${analise.nome}`);

    // ============================================================
    // 9. GERAÇÃO DO PDF (Screenshot de ambas as páginas)
    // ============================================================
    console.log("[DETRAN] Gerando PDF...");
    const pdfDoc = await PDFDocument.create();

    // Página 1 do PDF
    const img1 = await pdfDoc.embedPng(screenshotPag1);
    const pag1 = pdfDoc.addPage([img1.width, img1.height]);
    pag1.drawImage(img1, { x: 0, y: 0, width: img1.width, height: img1.height });

    // Página 2 do PDF (se existir)
    if (screenshotPag2) {
      const img2 = await pdfDoc.embedPng(screenshotPag2);
      const pag2 = pdfDoc.addPage([img2.width, img2.height]);
      pag2.drawImage(img2, { x: 0, y: 0, width: img2.width, height: img2.height });
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    console.log(`[DETRAN] PDF gerado! ${screenshotPag2 ? "2 páginas" : "1 página"} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
    console.log("[DETRAN] ========================================");
    console.log("[DETRAN] Automação concluída com sucesso!");
    console.log("[DETRAN] ========================================");

    // ============================================================
    // 10. RETORNO
    // ============================================================
    return {
      pdfBuffer,
      analise,
    };

  } catch (error) {
    console.error(`[DETRAN] ERRO: ${error.message}`);

    if (error.message.includes("DETRAN_FAIL")) {
      throw error;
    }

    throw new Error(`DETRAN_FAIL: ${error.message}`);

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log("[DETRAN] Navegador fechado.");
    }
  }
}

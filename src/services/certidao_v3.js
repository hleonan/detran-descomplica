// src/services/certidao_v3.js
// ============================================================
// Despachante Virtual RJ - Automação de Certidão DETRAN
// ============================================================
// Versão 3.2 - Corrigida com base em 15 certidões reais
//
// Fluxo:
// 1. Acessa URL direta do formulário (rápido)
// 2. Preenche CPF/CNH + resolve reCAPTCHA via 2Captcha
// 3. Clica "Consultar" → valida resultado (trava DETRAN_FAIL)
// 4. Clica "CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO" (página 2)
// 5. Classifica usando FRASES EXATAS do DETRAN
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
 * Classifica a situação da CNH usando FRASES EXATAS do DETRAN-RJ.
 *
 * Baseado na análise de 15 certidões reais.
 *
 * Cenários:
 *   "OK"        → NADA CONSTA
 *   "MULTAS"    → Só multas (sem suspensão/cassação)
 *   "SUSPENSAO" → Processo de suspensão (sem cassação)
 *   "CASSACAO"  → Processo de cassação
 *
 * Retorna objeto analise com: status, motivo, temProblemas, temMultas,
 * temSuspensao, temCassacao, nome, numeroCertidao
 */
function classificarCertidao(textoCompleto) {
  const textoUpper = textoCompleto.toUpperCase();

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
    /(?:CERTIFICAMOS QUE[^:]*:\s*)([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]{5,}?)(?:,\s*VINCULADO)/i,
    /VINCULADO AO CPF[^:]*:\s*\d+[^A-Z]*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]{5,}?)(?:\.|,|$)/i,
  ];
  for (const pattern of nomePatterns) {
    const match = textoCompleto.match(pattern);
    if (match && match[1]) {
      analise.nome = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  // ── Extrair número da certidão ──
  const certidaoMatch = textoCompleto.match(/N[°ºo]?\s*:\s*(\d{4}\.\d+)/i);
  if (certidaoMatch) {
    analise.numeroCertidao = certidaoMatch[1].trim();
  }

  // ============================================================
  // CLASSIFICAÇÃO USANDO FRASES EXATAS DO DETRAN
  // ============================================================

  // ── 1. NADA CONSTA (frase exata) ──
  if (textoUpper.includes("NADA CONSTA, NO SISTEMA DE INFRA")) {
    analise.status = "OK";
    analise.temProblemas = false;
    analise.motivo = "Parabéns! Sua CNH está limpa, sem nenhuma ocorrência registrada no DETRAN.";
    console.log("[CLASSIFICAÇÃO] ✅ NADA CONSTA");
    return analise;
  }

  // ── 2. CASSAÇÃO (verifica número > 0) ──
  const cassacaoMatch = textoUpper.match(/CONDUTOR POSSUI (\d+) PENALIDADE\(S\) DE CASSACAO/);
  if (cassacaoMatch) {
    const numCassacao = parseInt(cassacaoMatch[1], 10);
    if (numCassacao > 0) {
      analise.status = "CASSACAO";
      analise.temProblemas = true;
      analise.temCassacao = true;
      analise.temSuspensao = true; // Cassação sempre vem com suspensão
      analise.temMultas = true;
      analise.motivo =
        "Sua CNH está em risco de cassação. Isso significa que você pode perder sua habilitação e precisar iniciar um novo processo do zero. Nossa equipe pode te ajudar a reverter essa situação.";
      console.log(`[CLASSIFICAÇÃO] 🚨 CASSAÇÃO (${numCassacao} processo(s))`);
      return analise;
    }
  }

  // ── 3. SUSPENSÃO (verifica número > 0) ──
  const suspensaoMatch = textoUpper.match(/CONDUTOR POSSUI (\d+) PENALIDADE\(S\) DE SUSPENSAO/);
  if (suspensaoMatch) {
    const numSuspensao = parseInt(suspensaoMatch[1], 10);
    if (numSuspensao > 0) {
      analise.status = "SUSPENSAO";
      analise.temProblemas = true;
      analise.temSuspensao = true;
      analise.temMultas = true;
      analise.motivo =
        "Sua CNH está em risco iminente de suspensão. Identificamos um processo de suspensão do direito de dirigir. Nossa equipe pode te ajudar a resolver antes que seja tarde.";
      console.log(`[CLASSIFICAÇÃO] ⚠️ SUSPENSÃO (${numSuspensao} processo(s))`);
      return analise;
    }
  }

  // ── 4. MULTAS (sem suspensão/cassação) ──
  const temMultasTexto =
    textoUpper.includes("CONDUTOR NAO POSSUI PENALIDADE DE SUSPENSAO") ||
    textoUpper.includes("NENHUM REGISTRO ENCONTRADO PARA PENALIDADES DE SUSPENSAO");

  const temInfracoes =
    textoUpper.includes("TODAS AS INFRACOES - 5 ANOS") ||
    textoUpper.includes("MULTAS (") ||
    /QTD DE AUTOS[^\d]*\d+/.test(textoUpper);

  if (temMultasTexto && temInfracoes) {
    analise.status = "MULTAS";
    analise.temProblemas = true;
    analise.temMultas = true;
    analise.motivo =
      "Identificamos multas no seu prontuário. Se não forem tratadas, podem gerar um processo de suspensão da sua CNH. Nossa equipe pode te ajudar a resolver.";
    console.log("[CLASSIFICAÇÃO] 📋 MULTAS");
    return analise;
  }

  // ── 5. FALLBACK ──
  // Se chegou aqui, pode ser um caso edge ou certidão vazia
  if (textoUpper.includes("CERTIDAO") || textoUpper.includes("CERTIFICAMOS")) {
    analise.status = "OK";
    analise.temProblemas = false;
    analise.motivo = "Certidão emitida. Sem restrições aparentes.";
    console.log("[CLASSIFICAÇÃO] ✅ OK (fallback)");
  } else {
    console.warn("[CLASSIFICAÇÃO] ⚠️ Não foi possível classificar o documento.");
  }

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
  console.log("[DETRAN] Iniciando automação (v3.2 - Frases Exatas)");
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
    await page.waitForTimeout(3000);

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
      textoUpperP1.includes("CERTIDAO") ||
      textoUpperP1.includes("CERTIFICAMOS") ||
      textoUpperP1.includes("NADA CONSTA") ||
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

    // Verifica se o link existe no texto
    const temLinkExtrato = textoUpperP1.includes("CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO");

    if (temLinkExtrato) {
      console.log("[DETRAN] Link de extrato detectado no texto. Tentando clicar...");

      // Estratégia 1: Procurar por texto exato em links
      try {
        const linkExtrato = await page.locator('a:has-text("CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO")').first();
        if (await linkExtrato.isVisible({ timeout: 2000 }).catch(() => false)) {
          await linkExtrato.click();
          clicouExtrato = true;
          console.log("[DETRAN] ✅ Clicou via locator text");
        }
      } catch (e) {
        console.log("[DETRAN] Estratégia 1 falhou, tentando próxima...");
      }

      // Estratégia 2: Procurar por href contendo "extrato"
      if (!clicouExtrato) {
        try {
          const linkHref = await page.$('a[href*="extrato" i]');
          if (linkHref && (await linkHref.isVisible())) {
            await linkHref.click();
            clicouExtrato = true;
            console.log("[DETRAN] ✅ Clicou via href");
          }
        } catch (e) {
          console.log("[DETRAN] Estratégia 2 falhou, tentando próxima...");
        }
      }

      // Estratégia 3: JavaScript click em todos os links com texto relevante
      if (!clicouExtrato) {
        clicouExtrato = await page.evaluate(() => {
          const links = document.querySelectorAll("a");
          for (const link of links) {
            const txt = (link.innerText || link.textContent || "").toUpperCase();
            if (
              txt.includes("EXTRATO COMPLETO") ||
              txt.includes("EMITIR EXTRATO") ||
              txt.includes("CLIQUE AQUI")
            ) {
              link.click();
              return true;
            }
          }
          return false;
        });
        if (clicouExtrato) {
          console.log("[DETRAN] ✅ Clicou via JavaScript");
        }
      }

      if (clicouExtrato) {
        console.log("[DETRAN] Aguardando carregamento da Página 2...");
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {
          console.log("[DETRAN] NetworkIdle timeout na Página 2");
        });
        await page.waitForTimeout(3000);

        // Captura texto e screenshot da Página 2
        textoExtrato = await page.evaluate(() => document.body.innerText);
        console.log(`[DETRAN] Texto Extrato (200 chars): ${textoExtrato.substring(0, 200)}...`);

        screenshotPag2 = await page.screenshot({ fullPage: true, type: "png" });
        console.log("[DETRAN] ✅ Screenshot da Página 2 capturado!");
      } else {
        console.warn("[DETRAN] ⚠️ Não conseguiu clicar no link de extrato. Usando apenas Página 1.");
      }
    } else {
      console.log("[DETRAN] Link de extrato NÃO encontrado no texto. Provavelmente é 'Nada Consta'.");
    }

    // ============================================================
    // 8. CLASSIFICAR A SITUAÇÃO (FRASES EXATAS)
    // ============================================================
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

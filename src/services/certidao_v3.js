// src/services/certidao_v3.js
// ============================================================
// VOCE RECORRE - Automacao de Certidao DETRAN
// ============================================================
// Versao 3.2 - Corrigida com base em 15 certidoes reais
//
// Fluxo:
// 1. Acessa URL direta do formulario (rapido)
// 2. Preenche CPF/CNH + resolve reCAPTCHA via 2Captcha
// 3. Clica "Consultar" valida resultado (trava DETRAN_FAIL)
// 4. Clica "CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO" (pagina 2)
// 5. Classifica usando FRASES EXATAS do DETRAN
// 6. Gera PDF via screenshot (ambas as paginas)
// 7. Retorna { pdfBuffer, analise } para o api.js
// ============================================================

import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

// URL direta do formulario de certidao (iframe do DETRAN)
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

// Frases que indicam ERRO na resposta do DETRAN
const FRASES_ERRO = [
  "DADOS INFORMADOS INVALIDOS",
  "DADOS INFORMADOS NAO CONFEREM",
  "NAO CONFEREM",
  "CNH NAO CADASTRADA",
  "CPF NAO CADASTRADO",
  "CNH NAO ENCONTRADA",
  "CPF NAO ENCONTRADO",
  "CAPTCHA INCORRETO",
  "ERRO NA CONSULTA",
  "CODIGO DE VERIFICACAO INCORRETO",
  "INFORME O CODIGO",
  "PREENCHA TODOS OS CAMPOS",
];

function normalizarTextoAnalise(texto = "") {
  return texto
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

async function extrairTextoDaPagina(page) {
  const textoPrincipal = await page.evaluate(() => {
    const tentativas = [];

    tentativas.push(document.body?.innerText || "");
    tentativas.push(document.body?.textContent || "");

    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        tentativas.push(iframe.contentDocument?.body?.innerText || "");
        tentativas.push(iframe.contentDocument?.body?.textContent || "");
      } catch (e) {
        // ignora iframes com CORS
      }
    }

    return tentativas
      .map((t) => (t || "").replace(/\s+/g, " ").trim())
      .sort((a, b) => b.length - a.length)[0] || "";
  });

  if (textoPrincipal && textoPrincipal.length > 120) return textoPrincipal;

  let melhorTexto = textoPrincipal || "";
  for (const frame of page.frames()) {
    const txt = await frame
      .evaluate(() => (document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim())
      .catch(() => "");

    if (txt.length > melhorTexto.length) melhorTexto = txt;
  }

  return melhorTexto;
}


async function tentarCliqueExtratoNoContexto(contexto, nomeContexto = "pagina") {
  const seletores = [
    'a:has-text("CLIQUE AQUI")',
    'a:has-text("EXTRATO COMPLETO")',
    'a[href*="extrato" i]',
    'a[href*="emitir" i]',
    'area[alt*="EXTRATO" i]',
    'area[alt*="CLIQUE" i]',
    '[onclick*="extrato" i]',
    'img[alt*="EXTRATO" i]',
  ];

  for (const seletor of seletores) {
    try {
      const alvo = await contexto.locator(seletor).first();
      const existe = await alvo.count();
      if (!existe) continue;

      await alvo.click({ timeout: 2000 });
      console.log(`[DETRAN] ✅ Clique no extrato via seletor (${nomeContexto}): ${seletor}`);
      return true;
    } catch (e) {
      // tenta o proximo
    }
  }

  const clicouViaJS = await contexto
    .evaluate(() => {
      const normalizar = (txt) =>
        (txt || "")
          .toString()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toUpperCase();

      const candidatos = Array.from(
        document.querySelectorAll('a, area, button, [role="button"], [onclick], img[usemap]')
      );

      for (const el of candidatos) {
        const texto = normalizar(el.innerText || el.textContent || "");
        const href = normalizar(el.getAttribute("href") || "");
        const onclick = normalizar(el.getAttribute("onclick") || "");

        const alvoExtrato =
          texto.includes("EXTRATO") ||
          texto.includes("CLIQUE AQUI") ||
          href.includes("EXTRATO") ||
          onclick.includes("EXTRATO");

        if (alvoExtrato) {
          el.click();
          return true;
        }
      }

      return false;
    })
    .catch(() => false);

  if (clicouViaJS) {
    console.log(`[DETRAN] ✅ Clique no extrato via JavaScript (${nomeContexto})`);
    return true;
  }

  return false;
}

async function tentarClicarExtrato(page) {
  const contextos = [
    { alvo: page, nome: "pagina principal" },
    ...page.frames().map((frame, i) => ({ alvo: frame, nome: `frame ${i + 1}` })),
  ];

  for (const { alvo, nome } of contextos) {
    const clicou = await tentarCliqueExtratoNoContexto(alvo, nome);
    if (clicou) return true;
  }

  return false;
}


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
    throw new Error(`2Captcha in.php erro: ${inData?.request || "resposta invalida"}`);
  }

  const requestId = inData.request;
  console.log(`[CAPTCHA] Request ID: ${requestId}. Aguardando resolucao...`);

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
 * Aguarda sinais reais de resultado após clicar em "Consultar",
 * evitando sleep fixo longo quando a resposta já chegou.
 */
async function aguardarResultadoConsulta(page) {
  const detectouRapido = await page
    .waitForFunction(() => {
      const txt = (document.body?.innerText || "").replace(/\s+/g, " ").toUpperCase();
      if (!txt || txt.length < 40) return false;

      const sinais = [
        "CERTIDAO",
        "CERTIFICAMOS",
        "NADA CONSTA",
        "CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO",
        "DADOS INFORMADOS",
        "NAO CONFEREM",
        "NAO CADASTRAD",
        "CAPTCHA INCORRETO",
        "CODIGO DE VERIFICACAO",
      ];

      return sinais.some((s) => txt.includes(s));
    }, { timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  if (detectouRapido) return;

  await page.waitForLoadState("networkidle", { timeout: 18000 }).catch(() => {
    console.log("[DETRAN] NetworkIdle timeout (seguindo com validacao de conteudo)");
  });
  await page.waitForTimeout(800);
}

async function esperarNovaAba(context, paginasAntes, timeoutMs = 4500) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const pages = context.pages();
    if (pages.length > paginasAntes) return pages[pages.length - 1];
    await new Promise((r) => setTimeout(r, 180));
  }
  return null;
}

async function aguardarCarregamentoCurto(page, timeoutMs = 15000) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {
    console.log("[DETRAN] DomContentLoaded timeout (seguindo)");
  });
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {
    console.log("[DETRAN] NetworkIdle timeout (seguindo)");
  });
  await page.waitForTimeout(700);
}

/**
 * Classifica a situacao da CNH usando FRASES EXATAS do DETRAN-RJ.
 *
 * Baseado na analise de 15 certidoes reais.
 *
 * Cenarios:
 *   "OK"        -> NADA CONSTA
 *   "MULTAS"    -> So multas (sem suspensao/cassacao)
 *   "SUSPENSAO" -> Processo de suspensao (sem cassacao)
 *   "CASSACAO"  -> Processo de cassacao
 *
 * Retorna objeto analise com: status, motivo, temProblemas, temMultas,
 * temSuspensao, temCassacao, nome, numeroCertidao
 */
function classificarCertidao(textoCompleto) {
  const textoNormalizado = normalizarTextoAnalise(textoCompleto);

  const analise = {
    status: "DESCONHECIDO",
    motivo: "Nao foi possivel validar automaticamente a certidao. Nossa equipe vai revisar o documento.",
    temProblemas: true,
    temMultas: false,
    temSuspensao: false,
    temCassacao: false,
    nome: null,
    numeroCertidao: null,
    dados: {},
  };
  // -- Extrair NOME do motorista --
  const nomePatterns = [
    /(?:CERTIFICAMOS QUE[^:]*:\s*)([A-Z\s]{5,}?)(?:,\s*VINCULADO)/i,
    /VINCULADO AO CPF[^:]*:\s*\d+[^A-Z]*([A-Z\s]{5,}?)(?:\.|,|$)/i,
  ];
  for (const pattern of nomePatterns) {
    const match = textoCompleto.match(pattern);
    if (match && match[1]) {
      analise.nome = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  const certidaoMatch = textoNormalizado.match(/N\s*[:ºO]?\s*(\d{4}\.\d+)/i);
  if (certidaoMatch) analise.numeroCertidao = certidaoMatch[1].trim();

  const contarPenalidades = (tipo) => {
    const regexes = [
      new RegExp(`POSSUI\\s+(\\d+)\\s+PENALIDADE\\(S\\)\\s+DE\\s+${tipo}`, "g"),
      new RegExp(`PENALIDADE\\(S\\)\\s+DE\\s+${tipo}[^\\d]{0,20}(\\d+)`, "g"),
    ];

  let maximo = 0;
    for (const regex of regexes) {
      for (const m of textoNormalizado.matchAll(regex)) {
        const n = parseInt(m[1] || "0", 10);
        if (!Number.isNaN(n) && n > maximo) maximo = n;
      }
    }
        return maximo;
  };
  
const contarInfracoes = () => {
    const regexes = [
      /TODAS AS INFRACOES\s*-\s*5 ANOS[^\d]{0,25}(\d{1,3})/g,
      /QTD\s*DE\s*AUTOS[^\d]{0,20}(\d{1,3})/g,
      /TODAS\s+AS\s+INFRACOES\s*(?:\n|\r|\s)*QTD\s*DE\s*AUTOS[^\d]{0,25}(\d{1,3})/g,
    ];

    let maximo = 0;
    for (const regex of regexes) {
      for (const m of textoNormalizado.matchAll(regex)) {
        const n = parseInt(m[1] || "0", 10);
        if (!Number.isNaN(n) && n > maximo) maximo = n;
      }
    }
    return maximo;
  };

  const qtdCassacao = contarPenalidades("CASSACAO");
  const qtdSuspensao = contarPenalidades("SUSPENSAO");
  const qtdInfracoes = contarInfracoes();

 analise.dados = { qtdCassacao, qtdSuspensao, qtdInfracoes };

  const temFraseNadaConsta =
    textoNormalizado.includes("NADA CONSTA, NO SISTEMA DE INFRACOES") ||
    textoNormalizado.includes("NADA CONSTA NO SISTEMA DE INFRACOES") ||
    textoNormalizado.includes("NADA CONSTA, NO SISTEMA DE INFRACAO") ||
    textoNormalizado.includes("NADA CONSTA NO SISTEMA DE INFRACAO");

  const temMarcadorExtrato =
    textoNormalizado.includes("CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO") ||
    textoNormalizado.includes("EMITIR EXTRATO COMPLETO");

  const temTabelaInfracoes =
    textoNormalizado.includes("TODAS AS INFRACOES") ||
    textoNormalizado.includes("QTD DE AUTOS") ||
    textoNormalizado.includes("PONTUAVEIS - 12 MESES") ||
    textoNormalizado.includes("INFRACOES MANDATORIAS - 12 MESES");

  const temMarcadorOcorrencia = temMarcadorExtrato || temTabelaInfracoes;

  // Prioridade 1: penalidades graves
  if (qtdCassacao > 0) {
    analise.status = "CASSACAO";
    analise.temProblemas = true;
    analise.temCassacao = true;
    analise.temSuspensao = qtdSuspensao > 0;
    analise.temMultas = qtdInfracoes > 0 || temMarcadorOcorrencia;
    analise.motivo = "Identificamos processo de cassacao ativo no DETRAN.";
    return analise;
  }

  if (qtdSuspensao > 0) {
    analise.status = "SUSPENSAO";
    analise.temProblemas = true;
    analise.temSuspensao = true;
    analise.temMultas = qtdInfracoes > 0 || temMarcadorOcorrencia;
    analise.motivo = "Identificamos processo de suspensao do direito de dirigir.";
    return analise;
  }

  // Prioridade 2: ocorrencia de multas (quantidade OU marcadores estruturais da pagina de extrato)
  if (qtdInfracoes > 0 || temMarcadorOcorrencia) {
    analise.status = "MULTAS";
    analise.temProblemas = true;
    analise.temMultas = true;
    analise.motivo = "Identificamos ocorrencias/multas no prontuario do condutor.";
    return analise;
  }

  // Prioridade 3: NADA CONSTA somente quando nao houver qualquer marcador de ocorrencia
  if (temFraseNadaConsta && !temMarcadorOcorrencia && qtdCassacao === 0 && qtdSuspensao === 0) {
    analise.status = "OK";
    analise.temProblemas = false;
    analise.temMultas = false;
    analise.motivo = "Nada consta no sistema de infracoes do DETRAN.";
    return analise;
  }

  if (textoNormalizado.includes("CERTIDAO") || textoNormalizado.includes("CERTIFICAMOS")) {
    analise.status = "DESCONHECIDO";
    analise.temProblemas = true;
    analise.motivo = "Certidao emitida, mas o resultado nao foi identificado com seguranca. Nossa equipe vai revisar.";
  }

  return analise;
}


/**
 * Funcao principal: Emite a certidao do DETRAN-RJ.
 *
 * @param {string} cpf - CPF do motorista
 * @param {string} cnh - Numero da CNH
 * @returns {Promise<{pdfBuffer: Buffer, analise: Object}>}
 */
export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] ========================================");
  console.log("[DETRAN] Iniciando automacao (v3.2 - Frases Exatas)");
  console.log("[DETRAN] ========================================");

  if (!cpf || !cnh) throw new Error("CPF e CNH sao obrigatorios");

  const cpfLimpo = cpf.replace(/\D/g, "");
  const cnhLimpo = cnh.replace(/\D/g, "");

  if (cpfLimpo.length !== 11) throw new Error("CPF invalido (deve ter 11 digitos)");
  if (cnhLimpo.length < 9) throw new Error("CNH invalida (deve ter pelo menos 9 digitos)");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY nao configurada no servidor");

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

    let page = await context.newPage();

    // ============================================================
    // 2. ACESSO DIRETO A URL DO FORMULARIO
    // ============================================================
    console.log("[DETRAN] Acessando URL direta do formulario...");
    await page.goto(CERTIDAO_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForSelector("#CertidaoCpf", {
      state: "visible",
      timeout: 30000,
    });
    console.log("[DETRAN] Formulario carregado!");

    // ============================================================
    // 3. PREENCHER FORMULARIO
    // ============================================================
    console.log("[DETRAN] Preenchendo CPF e CNH...");
    await page.fill("#CertidaoCpf", cpfLimpo);
    await page.fill("#CertidaoCnh", cnhLimpo);

    // ============================================================
    // 4. RESOLVER CAPTCHA
    // ============================================================
    console.log("[DETRAN] Procurando reCAPTCHA...");
    let sitekey = null;

    // Metodo 1: iframe do reCAPTCHA
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      const src = await recaptchaFrame.getAttribute("src");
      if (src) {
        const params = new URLSearchParams(src.split("?")[1] || "");
        sitekey = params.get("k");
      }
    }

    // Metodo 2: atributo data-sitekey
    if (!sitekey) {
      sitekey = await page
        .evaluate(() => {
          const el = document.querySelector(".g-recaptcha");
          return el ? el.getAttribute("data-sitekey") : null;
        })
        .catch(() => null);
    }

    // Metodo 3: frames internos
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
      throw new Error("DETRAN_FAIL: Nao foi possivel encontrar o reCAPTCHA na pagina.");
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
    await aguardarResultadoConsulta(page);

    // ============================================================
    // 6. TRAVA DE SEGURANCA -- Validacao do Resultado (Pagina 1)
    // ============================================================
    console.log("[DETRAN] Validando resultado da consulta (Pagina 1)...");
    const textoPagina1 = await extrairTextoDaPagina(page);
    const textoUpperP1 = textoPagina1.toUpperCase();
    const textoNormP1 = normalizarTextoAnalise(textoPagina1);

    console.log(`[DETRAN] Texto P1 (200 chars): ${textoPagina1.substring(0, 200)}...`);

    // Verifica ERRO
    const erroEncontrado = FRASES_ERRO.find((frase) =>
      textoNormP1.includes(normalizarTextoAnalise(frase))
    );
    if (erroEncontrado) {
      console.error(`[DETRAN] ERRO NA TELA: "${erroEncontrado}"`);
      throw new Error("DETRAN_FAIL: O site do DETRAN recusou os dados informados. Verifique CPF e CNH.");
    }

    // Alguns cenarios retornam para o proprio formulario (sem certidao concluida), gerando falso positivo.
    // Quando isso acontecer, tratamos como falha temporaria para nova tentativa/retorno ao usuario.
    const permaneceuNoFormulario = await page.evaluate(() => {
      const temCpf = Boolean(document.querySelector("#CertidaoCpf, input[name='CertidaoCpf'], input[name='cpf']"));
      const temCnh = Boolean(document.querySelector("#CertidaoCnh, input[name='CertidaoCnh'], input[name='cnh']"));
      const temBotaoConsultar = Boolean(document.querySelector("#btPesquisar, button#btPesquisar, input#btPesquisar, button[type='submit'], input[type='submit']"));
      const temRecaptcha = Boolean(document.querySelector("iframe[src*='recaptcha'], .g-recaptcha, textarea[name='g-recaptcha-response'], #g-recaptcha-response"));
      return temCpf && temCnh && temBotaoConsultar && temRecaptcha;
    });

    if (permaneceuNoFormulario) {
      console.warn("[DETRAN] Consulta retornou para a tela inicial/formulario. Evitando classificacao como OK.");
      throw new Error("DETRAN_RETRYABLE: O DETRAN nao retornou a certidao nesta tentativa (retorno ao formulario).");
    }

    // Verifica se tem conteudo minimo valido
    const temConteudoMinimo =
      textoUpperP1.includes("CERTIDAO") ||
      textoUpperP1.includes("CERTIFICAMOS") ||
      textoUpperP1.includes("NADA CONSTA") ||
      textoUpperP1.includes("CONDUTOR") ||
      (textoUpperP1.includes("CPF") && textoPagina1.length > 200);

    const textoP1Limpo = (textoPagina1 || "").replace(/\s+/g, " ").trim();
    if (!temConteudoMinimo) {
      if (textoP1Limpo.length < 120) {
        throw new Error("DETRAN_RETRYABLE: Pagina de resultado sem conteudo suficiente (possivel tela em branco/intermitencia).");
      }
      console.warn("[DETRAN] Pagina sem conteudo totalmente reconhecivel. Seguiremos com a certidao para analise conservadora.");
    }

    console.log("[DETRAN] Pagina 1 validada!");

    // -- Screenshot da Pagina 1 --
    console.log("[DETRAN] Capturando screenshot da Pagina 1...");
    const screenshotPag1 = await page.screenshot({ fullPage: true, type: "png" });
    if (!screenshotPag1 || screenshotPag1.length < 12000) {
      throw new Error("DETRAN_RETRYABLE: Screenshot da pagina 1 veio vazio ou muito pequeno.");
    }

    // ============================================================
    // 7. CLICAR NO "EXTRATO COMPLETO" (Pagina 2)
    // ============================================================
    console.log("[DETRAN] Procurando link do Extrato Completo...");
    let clicouExtrato = false;
    let screenshotPag2 = null;
    let textoExtrato = "";

    // Verifica se o link existe no texto
    const temLinkExtrato = textoUpperP1.includes("CLIQUE AQUI PARA EMITIR EXTRATO COMPLETO");

    if (temLinkExtrato) {
      console.log("[DETRAN] Link de extrato detectado no texto. Tentando clicar...");
      
      const qtdFrames = page.frames().length;
      console.log(`[DETRAN] Contextos disponiveis para clique: pagina principal + ${qtdFrames} frame(s)`);
      
      clicouExtrato = await tentarClicarExtrato(page);

      if (clicouExtrato) {
        console.log("[DETRAN] Aguardando carregamento da Pagina 2...");

        const paginasAntes = context.pages().length;
        const novaAba = await esperarNovaAba(context, paginasAntes);
        const paginasDepois = context.pages();
        console.log(`[DETRAN] Total de abas abertas: ${paginasDepois.length}`);

        if (novaAba || paginasDepois.length > paginasAntes) {
          console.log("[DETRAN] Nova aba detectada! Mudando para a nova aba...");
          page = novaAba || paginasDepois[paginasDepois.length - 1];
          await page.bringToFront();

          await aguardarCarregamentoCurto(page, 22000);
        } else {
          await aguardarCarregamentoCurto(page, 18000);
        }

        textoExtrato = await extrairTextoDaPagina(page);
        console.log(`[DETRAN] Texto Extrato (200 chars): ${textoExtrato.substring(0, 200)}...`);

        if (textoExtrato.length > textoPagina1.length * 1.05 || textoExtrato.includes("PENALIDADE") || textoExtrato.includes("PROCESSO")) {
          screenshotPag2 = await page.screenshot({ fullPage: true, type: "png" });
          console.log("[DETRAN] ✅ Screenshot da Pagina 2 capturado!");
        } else {
          console.warn("[DETRAN] ⚠️ Pagina 2 sem diferenca relevante. Mantendo apenas Pagina 1.");
          screenshotPag2 = null;
        }
      } else {
        console.warn("[DETRAN] ⚠️ Nao conseguiu clicar no link de extrato (incluindo tentativa em frames). Usando apenas Pagina 1.");
      }
    } else {
      console.log("[DETRAN] Link de extrato NAO encontrado no texto. Provavelmente e 'Nada Consta'.");
    }

    
    // ============================================================
    // 8. CLASSIFICAR A SITUACAO (FRASES EXATAS)
    // ============================================================
    const textoCompleto = textoPagina1 + "\n" + textoExtrato;

    console.log("[DETRAN] Classificando situacao da CNH...");
    const analise = classificarCertidao(textoCompleto);

    console.log(`[DETRAN] ??? RESULTADO FINAL ???`);
    console.log(`[DETRAN] Status: ${analise.status}`);
    console.log(`[DETRAN] Motivo: ${analise.motivo}`);
    console.log(`[DETRAN] Multas: ${analise.temMultas} | Suspensao: ${analise.temSuspensao} | Cassacao: ${analise.temCassacao}`);
    if (analise.nome) console.log(`[DETRAN] Nome: ${analise.nome}`);

    // ============================================================
    // 9. GERACAO DO PDF (Screenshot de ambas as paginas)
    // ============================================================
    console.log("[DETRAN] Gerando PDF...");
    const pdfDoc = await PDFDocument.create();

    // Pagina 1 do PDF
    const img1 = await pdfDoc.embedPng(screenshotPag1);
    const pag1 = pdfDoc.addPage([img1.width, img1.height]);
    pag1.drawImage(img1, { x: 0, y: 0, width: img1.width, height: img1.height });

    // Pagina 2 do PDF (se existir)
    if (screenshotPag2) {
      const img2 = await pdfDoc.embedPng(screenshotPag2);
      const pag2 = pdfDoc.addPage([img2.width, img2.height]);
      pag2.drawImage(img2, { x: 0, y: 0, width: img2.width, height: img2.height });
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    console.log(`[DETRAN] PDF gerado! ${screenshotPag2 ? "2 paginas" : "1 pagina"} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
    console.log("[DETRAN] ========================================");
    console.log("[DETRAN] Automacao concluida com sucesso!");
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

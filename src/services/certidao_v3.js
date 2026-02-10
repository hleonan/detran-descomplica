// src/services/certidao_v3.js
// Automação para emitir Certidão de Nada Consta no DETRAN-RJ
// Baseado no código funcional do Mac (server.mjs) - adaptado para Playwright
//
// ESTRATÉGIA: Acessar DIRETAMENTE a URL do iframe (www2.detran.rj.gov.br)
// Classificar o resultado PELO HTML da página (não pelo PDF, que é screenshot/imagem)
//
// Seletores: #CertidaoCpf, #CertidaoTipo (value '2' = CNH), #CertidaoCnh, #btPesquisar
// Sitekey reCAPTCHA: 6LfP47IUAAAAAIwbI5NOKHyvT9Pda17dl0nXl4xv

import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

// URL direta do formulário (mesma que o Mac usava)
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";
const RECAPTCHA_SITEKEY = "6LfP47IUAAAAAIwbI5NOKHyvT9Pda17dl0nXl4xv";

/**
 * Preenche um input simulando comportamento humano
 * (Baseado na função fillInputHuman do server.mjs original)
 */
async function fillInputHuman(page, selector, value) {
  await page.waitForSelector(selector, { state: "visible", timeout: 15000 });
  await page.click(selector, { clickCount: 3 }); // Seleciona tudo
  await page.keyboard.press("Backspace");          // Limpa
  await page.type(selector, String(value), { delay: 80 + Math.random() * 40 });
  // Disparar eventos como o código original fazia
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }, selector);
}

/**
 * Analisa o HTML da página de resultado para classificar a certidão
 * Retorna: { temProblemas, status, motivo, nome, numeroCertidao, dados }
 */
async function analisarResultadoPagina(page) {
  return await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const bodyUpper = body.toUpperCase();

    // Extrair nome do motorista
    let nome = null;
    const nomeMatch = body.match(/que contra:\s*([A-ZÁÉÍÓÚÃÕÂÊÔÇ\s]+),?\s*vinculado/i);
    if (nomeMatch) {
      nome = nomeMatch[1].trim();
    }

    // Extrair número da certidão
    let numeroCertidao = null;
    const certMatch = body.match(/N[°º]:\s*([\d.]+)/);
    if (certMatch) {
      numeroCertidao = certMatch[1];
    }

    // Extrair CPF da certidão
    let cpfCertidao = null;
    const cpfMatch = body.match(/CPF:\s*([\d./-]+)/);
    if (cpfMatch) {
      cpfCertidao = cpfMatch[1].replace(/\D/g, "");
    }

    // ============================================
    // REGRAS DE CLASSIFICAÇÃO (baseadas na análise visual das certidões reais)
    // ============================================

    // REGRA 1: Se tem "NADA CONSTA" E NÃO tem tabela de infrações → LIMPO
    const temNadaConsta = bodyUpper.includes("NADA CONSTA");
    const temTabelaInfracoes = bodyUpper.includes("TODAS AS INFRA");
    const temCliqueAqui = bodyUpper.includes("CLIQUE AQUI");
    const temExtrato = bodyUpper.includes("EXTRATO COMPLETO");

    // REGRA 2: Verificar penalidades de suspensão
    const temSuspensao = bodyUpper.includes("POSSUI") && bodyUpper.includes("SUSPENS");
    const naoTemSuspensao = bodyUpper.includes("NAO POSSUI") && bodyUpper.includes("SUSPENS");
    const possuiSuspensaoMatch = body.match(/POSSUI\s+(\d+)\s+PENALIDADE.*SUSPENS/i);
    const qtdSuspensao = possuiSuspensaoMatch ? parseInt(possuiSuspensaoMatch[1]) : 0;

    // REGRA 3: Verificar penalidades de cassação
    const temCassacao = bodyUpper.includes("POSSUI") && bodyUpper.includes("CASSA");
    const possuiCassacaoMatch = body.match(/POSSUI\s+(\d+)\s+PENALIDADE.*CASSA/i);
    const qtdCassacao = possuiCassacaoMatch ? parseInt(possuiCassacaoMatch[1]) : 0;

    // REGRA 4: Extrair dados da tabela de infrações
    let infracoesResumo = null;
    const infracoesMatch = body.match(/Infra.*5 anos\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (infracoesMatch) {
      infracoesResumo = {
        qtdAutos5anos: parseInt(infracoesMatch[1]),
        autuacao: parseInt(infracoesMatch[2]),
        penalidade: parseInt(infracoesMatch[3]),
        transitado: parseInt(infracoesMatch[4]),
        pontos: parseInt(infracoesMatch[5]),
      };
    }

    // ============================================
    // DECISÃO FINAL
    // ============================================
    let temProblemas = false;
    let status = "OK";
    let motivo = "Certidão Nada Consta";
    const detalhes = [];

    // Se tem tabela de infrações ou link "Clique aqui" → TEM OCORRÊNCIA
    if (temTabelaInfracoes || temCliqueAqui || temExtrato) {
      temProblemas = true;
      status = "RESTRICAO";

      if (infracoesResumo && infracoesResumo.qtdAutos5anos > 0) {
        detalhes.push(`${infracoesResumo.qtdAutos5anos} infração(ões) nos últimos 5 anos`);
      }

      if (qtdSuspensao > 0) {
        detalhes.push(`${qtdSuspensao} penalidade(s) de suspensão do direito de dirigir`);
      }

      if (qtdCassacao > 0) {
        detalhes.push(`${qtdCassacao} penalidade(s) de cassação da CNH`);
      }

      if (infracoesResumo && infracoesResumo.pontos > 0) {
        detalhes.push(`${infracoesResumo.pontos} ponto(s) no prontuário`);
      }

      motivo = detalhes.length > 0
        ? detalhes.join(". ") + "."
        : "Foram encontradas ocorrências no prontuário.";
    }

    // Se NÃO tem tabela E tem "NADA CONSTA" → LIMPO
    if (!temTabelaInfracoes && !temCliqueAqui && temNadaConsta) {
      temProblemas = false;
      status = "OK";
      motivo = "Certidão Nada Consta";
    }

    return {
      temProblemas,
      status,
      motivo,
      nome,
      numeroCertidao,
      cpfCertidao,
      dados: {
        temNadaConsta,
        temTabelaInfracoes,
        temCliqueAqui,
        temExtrato,
        qtdSuspensao,
        qtdCassacao,
        infracoesResumo,
        naoTemSuspensao,
      },
    };
  });
}

/**
 * Emite a Certidão de Nada Consta e retorna o PDF + análise
 * @returns {{ pdfBuffer: Buffer, analise: object }}
 */
export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] ========== INICIANDO ==========");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  const cpfDigits = cpf.replace(/\D/g, "");
  const cnhDigits = cnh.replace(/\D/g, "");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY não configurada");

  // Verificar saldo 2Captcha antes de começar
  try {
    const balResp = await fetch(
      `https://2captcha.com/res.php?key=${twocaptchaKey}&action=getbalance&json=1`
    );
    const balData = await balResp.json();
    if (balData.status === 1) {
      const balance = Number(balData.request);
      console.error(`[DETRAN] Saldo 2Captcha: $${balance}`);
      if (balance < 0.01) throw new Error(`Saldo 2Captcha insuficiente: $${balance}`);
    }
  } catch (e) {
    if (e.message.includes("Saldo")) throw e;
    console.error(`[DETRAN] Aviso: não foi possível verificar saldo: ${e.message}`);
  }

  let browser;
  let page;

  try {
    // ===== 1. INICIAR NAVEGADOR =====
    console.error("[DETRAN] Iniciando navegador Chromium...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--disable-web-security",
        "--disable-extensions",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-plugins",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-first-run",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      ignoreHTTPSErrors: true,
    });

    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    // Anti-bot
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"] });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    });

    console.error("[DETRAN] Navegador iniciado.");

    // ===== 2. ACESSAR DIRETAMENTE A URL DO FORMULÁRIO =====
    console.error(`[DETRAN] Acessando ${CERTIDAO_URL}...`);
    await page.goto(CERTIDAO_URL, { waitUntil: "networkidle", timeout: 60000 });
    console.error(`[DETRAN] Página carregada. URL: ${page.url()}`);

    // ===== 3. PREENCHER FORMULÁRIO =====
    console.error("[DETRAN] Preenchendo CPF...");
    await fillInputHuman(page, "#CertidaoCpf", cpfDigits);

    console.error("[DETRAN] Selecionando tipo CNH...");
    await page.selectOption("#CertidaoTipo", "2"); // '2' = CNH
    await page.waitForTimeout(600);

    console.error("[DETRAN] Preenchendo CNH...");
    await fillInputHuman(page, "#CertidaoCnh", cnhDigits);

    console.error("[DETRAN] Dados preenchidos.");

    // ===== 4. RESOLVER CAPTCHA =====
    console.error("[DETRAN] Resolvendo reCAPTCHA via 2Captcha...");

    const captchaPageUrl = page.url() || CERTIDAO_URL;
    console.error(`[DETRAN] Sitekey: ${RECAPTCHA_SITEKEY}`);
    console.error(`[DETRAN] Page URL: ${captchaPageUrl}`);

    const submitUrl =
      `https://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha` +
      `&googlekey=${RECAPTCHA_SITEKEY}&pageurl=${encodeURIComponent(captchaPageUrl)}&json=1`;

    const submitResp = await fetch(submitUrl);
    const submitText = await submitResp.text();
    const submitData = JSON.parse(submitText);

    if (submitData.status !== 1) {
      throw new Error("Erro 2Captcha (envio): " + submitData.request);
    }

    const captchaId = submitData.request;
    console.error(`[DETRAN] Captcha enviado. ID: ${captchaId}. Aguardando resolução...`);

    // Polling (24 tentativas x 5s = 2 min)
    let token = null;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));

      const resResp = await fetch(
        `https://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${captchaId}&json=1`
      );
      const resText = await resResp.text();
      const resData = JSON.parse(resText);

      if (resData.status === 1) {
        token = resData.request;
        console.error("[DETRAN] Captcha resolvido!");
        break;
      }

      if (resData.request !== "CAPCHA_NOT_READY") {
        throw new Error("Erro 2Captcha (resultado): " + resData.request);
      }

      if (i % 4 === 0) {
        console.error(`[DETRAN] Aguardando captcha... (${i + 1}/24)`);
      }
    }

    if (!token) throw new Error("Timeout na resolução do Captcha (2 minutos).");

    // ===== 5. INJETAR TOKEN =====
    console.error("[DETRAN] Injetando token reCAPTCHA...");
    await page.evaluate((t) => {
      let textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (!textarea) {
        textarea = document.getElementById("g-recaptcha-response");
      }
      if (!textarea) {
        textarea = document.createElement("textarea");
        textarea.name = "g-recaptcha-response";
        textarea.id = "g-recaptcha-response";
        textarea.style.display = "none";
        document.body.appendChild(textarea);
      }
      textarea.value = t;
      textarea.innerHTML = t;

      const tokenEl = document.getElementById("recaptcha-token");
      if (tokenEl) tokenEl.value = t;

      try {
        if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
          const findCb = (obj, depth = 0) => {
            if (!obj || typeof obj !== "object" || depth > 8) return null;
            for (const key of Object.keys(obj)) {
              const val = obj[key];
              if (typeof val === "function" && key === "callback") return val;
              if (typeof val === "object" && val !== null) {
                if (val.callback && typeof val.callback === "function") return val.callback;
                const found = findCb(val, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };
          for (const client of Object.values(window.___grecaptcha_cfg.clients)) {
            const cb = findCb(client);
            if (cb) {
              cb(t);
              break;
            }
          }
        }
      } catch (e) {
        // Ignora erro de callback
      }
    }, token);

    await page.waitForTimeout(1000);

    // ===== 6. SUBMETER FORMULÁRIO =====
    console.error("[DETRAN] Clicando em CONSULTAR...");
    await page.click("#btPesquisar");

    console.error("[DETRAN] Aguardando resposta...");
    await page.waitForTimeout(8000);

    // ===== 7. ANALISAR RESULTADO PELO HTML (ANTES de fazer screenshot) =====
    console.error("[DETRAN] Analisando resultado da página...");
    const analise = await analisarResultadoPagina(page);
    console.error(`[DETRAN] Resultado: ${analise.status} - ${analise.motivo}`);
    console.error(`[DETRAN] Nome: ${analise.nome || "N/A"}`);
    console.error(`[DETRAN] Certidão Nº: ${analise.numeroCertidao || "N/A"}`);
    console.error(`[DETRAN] Tem problemas: ${analise.temProblemas}`);
    console.error(`[DETRAN] Dados: ${JSON.stringify(analise.dados)}`);

    // ===== 8. CAPTURAR SCREENSHOT PÁGINA 1 =====
    console.error("[DETRAN] Capturando screenshot página 1...");
    const shot1 = await page.screenshot({ fullPage: true, type: "png" });

    // ===== 9. PROCURAR LINK PARA EXTRATO COMPLETO =====
    let shot2 = null;

    if (analise.dados.temCliqueAqui || analise.dados.temExtrato) {
      console.error("[DETRAN] Procurando link para EMITIR EXTRATO COMPLETO...");
      try {
        const linkUrl = await page.evaluate(() => {
          const links = document.querySelectorAll("a");
          for (const link of links) {
            const texto = (link.textContent || "").toLowerCase();
            if (texto.includes("clique aqui") || texto.includes("extrato")) {
              return link.href;
            }
          }
          return null;
        });

        if (linkUrl) {
          console.error(`[DETRAN] Link encontrado: ${linkUrl}`);
          await page.goto(linkUrl, { waitUntil: "networkidle", timeout: 60000 });
          console.error("[DETRAN] Página 2 carregada.");
          await page.waitForTimeout(3000);

          console.error("[DETRAN] Capturando screenshot página 2...");
          shot2 = await page.screenshot({ fullPage: true, type: "png" });
        }
      } catch (e) {
        console.error(`[DETRAN] Erro ao acessar página 2: ${e.message}`);
      }
    } else {
      console.error("[DETRAN] Sem link de extrato (Nada Consta limpo).");
    }

    // ===== 10. GERAR PDF COM SCREENSHOTS =====
    console.error("[DETRAN] Gerando PDF com screenshots...");
    const pdf = await PDFDocument.create();

    // Página 1
    const img1 = await pdf.embedPng(shot1);
    const p1 = pdf.addPage([img1.width, img1.height]);
    p1.drawImage(img1, { x: 0, y: 0, width: img1.width, height: img1.height });

    // Página 2 (se existir)
    if (shot2) {
      const img2 = await pdf.embedPng(shot2);
      const p2 = pdf.addPage([img2.width, img2.height]);
      p2.drawImage(img2, { x: 0, y: 0, width: img2.width, height: img2.height });
      console.error("[DETRAN] PDF com 2 páginas.");
    } else {
      console.error("[DETRAN] PDF com 1 página.");
    }

    const pdfBytes = await pdf.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    console.error(`[DETRAN] PDF gerado! (${pdfBuffer.length} bytes)`);
    console.error("[DETRAN] ========== SUCESSO ==========");

    // RETORNA PDF + ANÁLISE (não só o PDF)
    return {
      pdfBuffer,
      analise: {
        temProblemas: analise.temProblemas,
        status: analise.status,
        motivo: analise.motivo,
        nome: analise.nome,
        numeroCertidao: analise.numeroCertidao,
        cpfCertidao: analise.cpfCertidao,
        dados: analise.dados,
      },
    };

  } catch (error) {
    console.error(`[DETRAN] ERRO: ${error.message}`);
    if (page) {
      try {
        const screenshotPath = `/tmp/erro_detran_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`[DETRAN] Screenshot de erro: ${screenshotPath}`);
      } catch (e) { /* ignora */ }
    }
    throw error;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignora */ }
    }
  }
}

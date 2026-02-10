// src/services/certidao_v3.js
// Automação para emitir Certidão de Nada Consta no DETRAN-RJ
// Usa Playwright + 2Captcha para resolver reCAPTCHA v2
//
// DESCOBERTA CHAVE: O formulário de consulta está dentro de um IFRAME!
// A página principal (www.detran.rj.gov.br) carrega o formulário via iframe de:
//   https://www2.detran.rj.gov.br/portal/multas/certidao
//
// Seletores dentro do iframe:
//   #CertidaoCpf, #CertidaoTipo (select: PGU/CNH), #CertidaoCnh, #btPesquisar
//
// Sitekey reCAPTCHA: 6LfP47IUAAAAAIwbI5NOKHyvT9Pda17dl0nXl4xv

import { chromium } from "playwright";

// URL direta do iframe que contém o formulário
const IFRAME_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";
// URL da página principal (para Referer)
const PAGE_URL = "https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html";
// Sitekey conhecida do reCAPTCHA
const RECAPTCHA_SITEKEY = "6LfP47IUAAAAAIwbI5NOKHyvT9Pda17dl0nXl4xv";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] Iniciando fluxo de emissão...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  const cpfDigits = cpf.replace(/\D/g, "");
  const cnhDigits = cnh.replace(/\D/g, "");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY não configurada");

  let browser;
  let page;

  try {
    // ===== 1. INICIAR NAVEGADOR =====
    console.error("[DETRAN] Iniciando navegador...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1366,768",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      ignoreHTTPSErrors: true,
    });

    page = await context.newPage();

    // Anti-bot
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"] });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer": PAGE_URL,
    });

    // ===== 2. ESTRATÉGIA: Acessar a página principal e trabalhar com o IFRAME =====
    // O formulário está dentro de um iframe de www2.detran.rj.gov.br
    // Vamos acessar a página principal e depois encontrar o iframe

    console.error("[DETRAN] Acessando página de Certidão de Nada Consta...");
    await page.goto(PAGE_URL, { waitUntil: "networkidle", timeout: 60000 });
    console.error(`[DETRAN] Página carregada. URL: ${page.url()}`);

    // Espera o iframe carregar
    await page.waitForTimeout(3000);

    // Encontrar o iframe do formulário
    console.error("[DETRAN] Procurando iframe do formulário...");
    let formFrame = null;

    // Listar todos os frames
    const frames = page.frames();
    console.error(`[DETRAN] Total de frames: ${frames.length}`);

    for (const frame of frames) {
      const frameUrl = frame.url();
      if (frameUrl.includes("www2.detran.rj.gov.br") || frameUrl.includes("portal/multas")) {
        formFrame = frame;
        console.error(`[DETRAN] Iframe do formulário encontrado: ${frameUrl}`);
        break;
      }
    }

    // Se não encontrou o iframe, tenta acessar diretamente
    if (!formFrame) {
      console.error("[DETRAN] Iframe não encontrado na página principal. Tentando acesso direto...");
      await page.goto(IFRAME_URL, {
        waitUntil: "networkidle",
        timeout: 60000,
        referer: PAGE_URL,
      });
      formFrame = page.mainFrame();
      console.error(`[DETRAN] Acesso direto. URL: ${page.url()}`);
    }

    // ===== 3. PREENCHER FORMULÁRIO (dentro do iframe) =====
    console.error("[DETRAN] Aguardando campo CPF no iframe...");
    await formFrame.waitForSelector("#CertidaoCpf", { state: "visible", timeout: 30000 });
    console.error("[DETRAN] Campo CPF encontrado!");

    // Selecionar tipo CNH
    const tipoSelect = await formFrame.$("#CertidaoTipo");
    if (tipoSelect) {
      console.error("[DETRAN] Selecionando tipo CNH...");
      await formFrame.selectOption("#CertidaoTipo", "CNH");
      await formFrame.waitForTimeout(500);
    }

    // Preencher CPF
    console.error("[DETRAN] Preenchendo CPF...");
    await formFrame.click("#CertidaoCpf");
    await formFrame.waitForTimeout(200);
    await formFrame.type("#CertidaoCpf", cpfDigits, { delay: 80 + Math.random() * 60 });
    await formFrame.waitForTimeout(300);

    // Preencher CNH
    console.error("[DETRAN] Preenchendo CNH...");
    await formFrame.click("#CertidaoCnh");
    await formFrame.waitForTimeout(200);
    await formFrame.type("#CertidaoCnh", cnhDigits, { delay: 80 + Math.random() * 60 });
    console.error("[DETRAN] Dados preenchidos.");

    // ===== 4. RESOLVER CAPTCHA =====
    console.error("[DETRAN] Resolvendo reCAPTCHA via 2Captcha...");

    // Extrair sitekey do iframe do reCAPTCHA (ou usar a conhecida)
    let sitekey = RECAPTCHA_SITEKEY;

    // Tentar extrair do iframe caso tenha mudado
    try {
      const recaptchaFrame = frames.find((f) => f.url().includes("recaptcha/api2/anchor"));
      if (recaptchaFrame) {
        const src = recaptchaFrame.url();
        const urlParams = new URLSearchParams(src.split("?")[1]);
        const extractedKey = urlParams.get("k");
        if (extractedKey) {
          sitekey = extractedKey;
          console.error(`[DETRAN] Sitekey extraída: ${sitekey}`);
        }
      }
    } catch (e) {
      console.error("[DETRAN] Usando sitekey padrão.");
    }

    // A URL que o reCAPTCHA protege é a do iframe (www2.detran.rj.gov.br)
    const captchaPageUrl = formFrame.url() || IFRAME_URL;
    console.error(`[DETRAN] Sitekey: ${sitekey}`);
    console.error(`[DETRAN] Captcha page URL: ${captchaPageUrl}`);

    // Enviar para 2Captcha
    const inUrl = `http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(captchaPageUrl)}&json=1`;
    const inResp = await fetch(inUrl);
    const inData = await inResp.json();
    if (inData.status !== 1) throw new Error("Erro 2Captcha (in): " + inData.request);

    const captchaId = inData.request;
    console.error(`[DETRAN] Captcha enviado. ID: ${captchaId}. Aguardando resolução...`);

    // Polling
    let token = null;
    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(3000);
      try {
        const resResp = await fetch(
          `http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${captchaId}&json=1`
        );
        const resData = await resResp.json();
        if (resData.status === 1) {
          token = resData.request;
          break;
        }
        if (resData.request !== "CAPCHA_NOT_READY") {
          throw new Error("Erro 2Captcha (res): " + resData.request);
        }
        if (i % 5 === 0) {
          console.error(`[DETRAN] Aguardando captcha... (${i + 1}/50)`);
        }
      } catch (fetchErr) {
        if (fetchErr.message.includes("2Captcha")) throw fetchErr;
        console.error(`[DETRAN] Erro polling: ${fetchErr.message}`);
      }
    }

    if (!token) throw new Error("Timeout na resolução do Captcha.");
    console.error("[DETRAN] Token obtido! Injetando no iframe...");

    // Injetar token DENTRO DO IFRAME do formulário
    await formFrame.evaluate((t) => {
      // Preenche o campo g-recaptcha-response
      const responseEl = document.getElementById("g-recaptcha-response");
      if (responseEl) {
        responseEl.innerHTML = t;
        responseEl.value = t;
        responseEl.style.display = "block";
      }

      // Tenta chamar o callback do reCAPTCHA
      try {
        if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
          const findCallback = (obj, depth = 0) => {
            if (!obj || typeof obj !== "object" || depth > 10) return null;
            for (const key of Object.keys(obj)) {
              const val = obj[key];
              if (typeof val === "function" && key === "callback") return val;
              if (typeof val === "object" && val !== null) {
                if (val.callback && typeof val.callback === "function") return val.callback;
                const found = findCallback(val, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };
          for (const client of Object.values(window.___grecaptcha_cfg.clients)) {
            const cb = findCallback(client);
            if (cb) {
              cb(t);
              console.log("[CAPTCHA] Callback executado!");
              break;
            }
          }
        }
      } catch (e) {
        console.log("[CAPTCHA] Callback error:", e);
      }
    }, token);

    await page.waitForTimeout(1000);

    // ===== 5. SUBMETER FORMULÁRIO =====
    console.error("[DETRAN] Clicando em CONSULTAR...");

    // Clicar no botão dentro do iframe
    await formFrame.evaluate(() => {
      const btn = document.getElementById("btPesquisar");
      if (btn) btn.click();
    });

    // Esperar resultado
    console.error("[DETRAN] Aguardando resultado...");

    // Esperar por navegação ou mudança no iframe
    await page.waitForTimeout(5000);

    // Verificar se o iframe navegou ou se apareceu resultado
    try {
      await formFrame.waitForLoadState("networkidle", { timeout: 30000 });
    } catch (e) {
      console.error("[DETRAN] Timeout no networkidle do iframe (pode ser normal).");
    }

    await page.waitForTimeout(3000);

    console.error(`[DETRAN] URL do iframe após consulta: ${formFrame.url()}`);

    // Verificar erro dentro do iframe
    const erroNaTela = await formFrame.evaluate(() => {
      const seletores = [
        ".alert-danger",
        "font[color='red']",
        ".error-message",
        ".mensagem-erro",
        ".flash-message",
        ".error",
      ];
      for (const sel of seletores) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) return el.innerText.trim();
      }
      return null;
    }).catch(() => null);

    if (erroNaTela) {
      console.error(`[DETRAN] Erro na tela: ${erroNaTela}`);
      throw new Error("DETRAN respondeu: " + erroNaTela);
    }

    // ===== 6. VERIFICAR EXTRATO DETALHADO =====
    console.error("[DETRAN] Verificando extrato detalhado...");
    const temExtrato = await formFrame.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')
      );
      const extrato = elements.find((el) => {
        const texto = (el.innerText || el.value || "").toLowerCase();
        return (
          texto.includes("extrato") ||
          texto.includes("detalhado") ||
          (texto.includes("emitir") && !texto.includes("consultar"))
        );
      });
      if (extrato) {
        extrato.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (temExtrato) {
      console.error("[DETRAN] Extrato detalhado clicado.");
      await page.waitForTimeout(5000);
    }

    // ===== 7. GERAR PDF =====
    console.error("[DETRAN] Gerando PDF...");

    // Para gerar o PDF, precisamos capturar a página inteira (incluindo iframe)
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    console.error(`[DETRAN] PDF gerado! (${pdfBuffer.length} bytes)`);
    return pdfBuffer;

  } catch (error) {
    console.error(`[DETRAN] ERRO: ${error.message}`);
    if (page) {
      try {
        const screenshotPath = `/tmp/erro_detran_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`[DETRAN] Screenshot: ${screenshotPath}`);
      } catch (e) { /* ignora */ }
    }
    throw error;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignora */ }
    }
  }
}

// src/services/certidao_v3.js
// Automação para emitir Certidão de Nada Consta no DETRAN-RJ
// Usa Playwright em modo Stealth + 2Captcha para resolver reCAPTCHA v2
//
// PROBLEMA RESOLVIDO: O site do DETRAN redireciona bots para uma página
// diferente (/consultas/consultas-drv/nada-consta.html = veículo/Renavam).
// A página correta de CNH é /infracoes/principais-servicos-infracoes/nada-consta.html
// SOLUÇÃO: Navegar pelo menu como um humano, com múltiplas tentativas.

import { chromium } from "playwright";

// URLs mapeadas conforme navegação real no site (verificado em 10/02/2026)
const HOME_URL = "https://www.detran.rj.gov.br/";
const MENU_INFRACOES_URL = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";
const NADA_CONSTA_URL = "https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html";

// Seletores confirmados na página correta
const SEL = {
  cpf: "#CertidaoCpf",
  tipo: "#CertidaoTipo",
  cnh: "#CertidaoCnh",
  btnConsultar: "#btPesquisar",
  recaptchaIframe: 'iframe[src*="recaptcha"]',
  recaptchaResponse: "#g-recaptcha-response",
};

export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] Iniciando fluxo de emissão (Stealth + Navegação Real)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  const cpfDigits = cpf.replace(/\D/g, "");
  const cnhDigits = cnh.replace(/\D/g, "");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY não configurada");

  let browser;
  let page;

  try {
    // ===== 1. INICIAR NAVEGADOR BLINDADO =====
    console.error("[DETRAN] Iniciando navegador blindado...");
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

    // Remove indicadores de automação
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["pt-BR", "pt", "en-US", "en"],
      });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
      // Esconde automação do Playwright
      delete window.__playwright;
      delete window.__pw_manual;
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    // ===== 2. NAVEGAÇÃO REAL (Home -> Menu -> Nada Consta) =====
    // Estratégia: Simular um humano que navega pelo site

    // Passo 2a: Acessar a HOME primeiro
    console.error("[DETRAN] Acessando home do DETRAN...");
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await humanDelay(page, 1500, 3000);

    // Passo 2b: Ir para o menu de infrações
    console.error("[DETRAN] Navegando para menu de infrações...");
    await page.goto(MENU_INFRACOES_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await humanDelay(page, 1000, 2500);

    // Passo 2c: Clicar no link "Emitir Certidão de Nada Consta"
    console.error("[DETRAN] Procurando link 'Emitir Certidão de Nada Consta'...");

    let chegouNaPaginaCorreta = false;

    // Tentativa 1: Clicar no link via texto
    const linkClicado = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      // Procura pelo texto exato
      const target = links.find((a) => {
        const texto = (a.textContent || "").trim().toLowerCase();
        return (
          texto.includes("emitir certid") && texto.includes("nada consta")
        );
      });
      if (target) {
        target.click();
        return true;
      }
      // Fallback: procura pela URL
      const target2 = links.find(
        (a) => a.href && a.href.includes("nada-consta.html") && a.href.includes("infracoes")
      );
      if (target2) {
        target2.click();
        return true;
      }
      return false;
    });

    if (linkClicado) {
      console.error("[DETRAN] Link clicado! Aguardando navegação...");
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      await humanDelay(page, 1000, 2000);
    }

    // Verificar se chegamos na página correta
    const urlAtual = page.url();
    console.error(`[DETRAN] URL atual: ${urlAtual}`);

    // Verificar se o campo #CertidaoCpf existe (confirma que estamos na página certa)
    const campoCpfExiste = await page.$(SEL.cpf);

    if (campoCpfExiste) {
      chegouNaPaginaCorreta = true;
      console.error("[DETRAN] Página correta encontrada (campo CertidaoCpf presente)!");
    } else {
      console.error("[DETRAN] Página ERRADA! Campo CertidaoCpf não encontrado.");
      console.error("[DETRAN] Provavelmente redirecionado para página de veículo.");

      // Tentativa 2: Acesso direto com Referer do menu
      console.error("[DETRAN] Tentativa 2: Acesso direto com Referer...");
      await page.goto(NADA_CONSTA_URL, {
        referer: MENU_INFRACOES_URL,
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await humanDelay(page, 1000, 2000);

      const campoCpfExiste2 = await page.$(SEL.cpf);
      if (campoCpfExiste2) {
        chegouNaPaginaCorreta = true;
        console.error("[DETRAN] Tentativa 2 funcionou!");
      } else {
        // Tentativa 3: Verificar se existe um formulário diferente na página
        console.error("[DETRAN] Tentativa 3: Verificando formulário alternativo...");

        // Checar se estamos na página de Renavam (redirecionamento)
        const campoRenavam = await page.$("#MultasRenavam");
        if (campoRenavam) {
          console.error("[DETRAN] DETECTADO: Redirecionamento para página de veículo/Renavam.");
          console.error("[DETRAN] Tentativa 3: Navegando via JavaScript...");

          // Tenta forçar a navegação via window.location
          await page.evaluate((url) => {
            window.location.href = url;
          }, NADA_CONSTA_URL);

          await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
          await humanDelay(page, 1000, 2000);

          const campoCpfExiste3 = await page.$(SEL.cpf);
          if (campoCpfExiste3) {
            chegouNaPaginaCorreta = true;
            console.error("[DETRAN] Tentativa 3 funcionou!");
          }
        }
      }
    }

    if (!chegouNaPaginaCorreta) {
      // Última tentativa: Verificar todos os inputs na página atual
      const inputsDisponiveis = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("input, select")).map(
          (el) => ({
            id: el.id,
            name: el.name,
            type: el.type,
            tag: el.tagName,
          })
        );
      });
      console.error("[DETRAN] Inputs disponíveis:", JSON.stringify(inputsDisponiveis));

      throw new Error(
        `Não foi possível acessar a página de Certidão de Nada Consta da CNH. ` +
        `URL final: ${page.url()}. ` +
        `O site pode estar redirecionando para outra página. ` +
        `Tente novamente em alguns minutos.`
      );
    }

    // ===== 3. PREENCHIMENTO DO FORMULÁRIO =====
    console.error("[DETRAN] Preenchendo formulário...");

    // Selecionar tipo CNH no dropdown
    const tipoSelect = await page.$(SEL.tipo);
    if (tipoSelect) {
      console.error("[DETRAN] Selecionando tipo CNH no dropdown...");
      await page.selectOption(SEL.tipo, "CNH");
      await humanDelay(page, 300, 600);
    }

    // Digitar CPF (devagar, como humano)
    await page.click(SEL.cpf);
    await humanDelay(page, 200, 400);
    await page.type(SEL.cpf, cpfDigits, { delay: 80 + Math.random() * 60 });
    await humanDelay(page, 300, 600);

    // Digitar CNH
    await page.click(SEL.cnh);
    await humanDelay(page, 200, 400);
    await page.type(SEL.cnh, cnhDigits, { delay: 80 + Math.random() * 60 });
    console.error("[DETRAN] Dados preenchidos.");

    // ===== 4. RESOLVER CAPTCHA (reCAPTCHA v2) =====
    console.error("[DETRAN] Verificando Captcha...");

    // Procura iframe do reCAPTCHA (pode ser anchor ou enterprise)
    const frameElement = await page.$(
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]'
    );

    if (frameElement) {
      console.error("[DETRAN] reCAPTCHA detectado. Resolvendo via 2Captcha...");

      const src = await frameElement.getAttribute("src");
      const urlParams = new URLSearchParams(src.split("?")[1]);
      const sitekey = urlParams.get("k");

      if (!sitekey) throw new Error("Sitekey do reCAPTCHA não encontrada no iframe.");

      console.error(`[DETRAN] Sitekey: ${sitekey}`);

      // Verificar se é Enterprise
      const isEnterprise = src.includes("enterprise");

      // Enviar para 2Captcha
      let inUrl = `http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(page.url())}&json=1`;
      if (isEnterprise) {
        inUrl += "&enterprise=1";
      }

      const inResp = await fetch(inUrl);
      const inData = await inResp.json();
      if (inData.status !== 1) throw new Error("Erro 2Captcha (in): " + inData.request);

      const captchaId = inData.request;
      console.error(`[DETRAN] Captcha enviado. ID: ${captchaId}. Aguardando resolução...`);

      // Polling para resultado (máximo ~2.5 minutos)
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
            console.error(`[DETRAN] Aguardando captcha... (tentativa ${i + 1}/50)`);
          }
        } catch (fetchErr) {
          console.error(`[DETRAN] Erro no polling: ${fetchErr.message}`);
        }
      }

      if (!token) throw new Error("Timeout na resolução do Captcha (2.5 minutos).");
      console.error("[DETRAN] Token do Captcha obtido! Injetando na página...");

      // Injetar token
      await page.evaluate((t) => {
        // Preenche o campo de resposta
        const responseEl = document.getElementById("g-recaptcha-response");
        if (responseEl) {
          responseEl.innerHTML = t;
          responseEl.value = t;
          responseEl.style.display = "block";
        }

        // Tenta chamar o callback do reCAPTCHA
        try {
          if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
            const findCallback = (obj) => {
              if (!obj || typeof obj !== "object") return null;
              for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (typeof val === "function") return val;
                if (typeof val === "object" && val !== null) {
                  // Procura recursivamente
                  if (val.callback && typeof val.callback === "function") return val.callback;
                  const found = findCallback(val);
                  if (found) return found;
                }
              }
              return null;
            };

            for (const client of Object.values(window.___grecaptcha_cfg.clients)) {
              const cb = findCallback(client);
              if (cb) {
                cb(t);
                break;
              }
            }
          }
        } catch (e) {
          console.log("[CAPTCHA] Callback:", e);
        }
      }, token);

      await humanDelay(page, 500, 1000);
    } else {
      console.error("[DETRAN] Nenhum reCAPTCHA detectado, prosseguindo...");
    }

    // ===== 5. SUBMETER FORMULÁRIO =====
    console.error("[DETRAN] Clicando em CONSULTAR...");

    // Usa Promise.all para capturar navegação + clique
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {}),
      page.evaluate(() => {
        const btn = document.getElementById("btPesquisar");
        if (btn) btn.click();
      }),
    ]);

    // Espera adicional para renderização
    await page.waitForTimeout(3000);

    console.error(`[DETRAN] Resultado carregado. URL: ${page.url()}`);

    // ===== 6. VERIFICAR RESULTADO =====
    // Verificar se deu erro na tela
    const erroNaTela = await page.evaluate(() => {
      const seletores = [
        ".alert-danger",
        "font[color='red']",
        ".error-message",
        ".mensagem-erro",
        ".flash-message",
      ];
      for (const sel of seletores) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) return el.innerText.trim();
      }
      return null;
    });

    if (erroNaTela) {
      console.error(`[DETRAN] Erro na tela: ${erroNaTela}`);
      throw new Error("DETRAN respondeu: " + erroNaTela);
    }

    // ===== 7. VERIFICAR EXTRATO DETALHADO =====
    console.error("[DETRAN] Verificando se há extrato detalhado disponível...");
    const temExtrato = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(
          'a, button, input[type="button"], input[type="submit"]'
        )
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
    });

    if (temExtrato) {
      console.error("[DETRAN] Extrato detalhado encontrado e clicado.");
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // ===== 8. GERAR PDF =====
    console.error("[DETRAN] Gerando PDF final...");
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });

    console.error(`[DETRAN] PDF gerado com sucesso! (${pdfBuffer.length} bytes)`);
    return pdfBuffer;
  } catch (error) {
    console.error(`[DETRAN] ERRO FINAL: ${error.message}`);
    if (page) {
      try {
        const screenshotPath = `/tmp/erro_detran_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`[DETRAN] Screenshot de erro salvo em: ${screenshotPath}`);
      } catch (e) {
        /* ignora */
      }
    }
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        /* ignora */
      }
    }
  }
}

/**
 * Simula delay humano aleatório
 */
async function humanDelay(page, minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await page.waitForTimeout(delay);
}

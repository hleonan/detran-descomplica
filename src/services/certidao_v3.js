// src/services/certidao_v3.js
// Automação para emitir Certidão de Nada Consta no DETRAN-RJ
// Usa Playwright em modo Stealth + 2Captcha para resolver reCAPTCHA v2

import { chromium } from "playwright";

// URLs mapeadas conforme navegação real no site
const MENU_URL = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";
const NADA_CONSTA_URL = "https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] Iniciando fluxo de emissão (Stealth + Navegação Real)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  const cpfFormatted = cpf.replace(/\D/g, "");
  const cnhFormatted = cnh.replace(/\D/g, "");

  // Verificar chave do 2Captcha
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY não configurada");

  let browser;
  let page;

  try {
    // 1. CONFIGURAÇÃO ANTI-BOT (Fingir ser um Humano no Chrome)
    console.error("[DETRAN] Iniciando navegador blindado...");
    browser = await chromium.launch({ 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,768',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ] 
    });
    
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        ignoreHTTPSErrors: true
    });

    page = await context.newPage();

    // Remove indicadores de automação
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    // Headers para parecer que veio do Google
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.detran.rj.gov.br/' 
    });

    // 2. NAVEGAÇÃO REAL (Menu -> Serviço)
    console.error(`[DETRAN] Acessando menu: ${MENU_URL}`);
    await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Espera um pouco para simular leitura humana
    await page.waitForTimeout(1000 + Math.random() * 2000);

    console.error("[DETRAN] Procurando link 'Nada Consta'...");
    
    // Tenta clicar no link exato
    const linkClicado = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const target = links.find(a => a.href && a.href.includes('nada-consta.html'));
        if (target) {
            target.click();
            return true;
        }
        return false;
    });

    if (linkClicado) {
        console.error("[DETRAN] Link clicado! Aguardando página do formulário...");
        await page.waitForLoadState('domcontentloaded');
    } else {
        console.error("[DETRAN] Link não achado no menu, tentando acesso direto com Referer...");
        await page.goto(NADA_CONSTA_URL, {
            referer: MENU_URL,
            waitUntil: "domcontentloaded",
            timeout: 45000
        });
    }

    // 3. PREENCHIMENTO DO FORMULÁRIO
    console.error("[DETRAN] Procurando campos de CPF/CNH...");
    
    // Espera pelos campos
    await page.waitForSelector("#CertidaoCpf", { state: 'visible', timeout: 30000 });
    console.error("[DETRAN] Campos encontrados!");

    // IMPORTANTE: Selecionar o tipo como "CNH" no dropdown (índice 1)
    // O site tem um select#CertidaoTipo com opções: PGU (0) e CNH (1)
    const tipoSelect = await page.$("#CertidaoTipo");
    if (tipoSelect) {
        console.error("[DETRAN] Selecionando tipo CNH no dropdown...");
        await page.selectOption("#CertidaoTipo", "CNH");
        await page.waitForTimeout(500);
    }

    // Digita devagar como um humano
    await page.type("#CertidaoCpf", cpfFormatted, { delay: 80 + Math.random() * 60 });
    await page.waitForTimeout(300);
    await page.type("#CertidaoCnh", cnhFormatted, { delay: 80 + Math.random() * 60 });
    console.error("[DETRAN] Dados preenchidos.");

    // 4. RESOLVER CAPTCHA (Recaptcha V2)
    console.error("[DETRAN] Verificando Captcha...");
    
    // Procura o iframe do Recaptcha
    const frameElement = await page.$('iframe[src*="recaptcha/api2/anchor"]');
    if (frameElement) {
        console.error("[DETRAN] Captcha detectado. Quebrando...");
        
        // Pega a URL do iframe para extrair a sitekey
        const src = await frameElement.getAttribute("src");
        const urlParams = new URLSearchParams(src.split("?")[1]);
        const sitekey = urlParams.get("k");

        if (!sitekey) throw new Error("Sitekey do Captcha não encontrada.");

        // Manda pro 2Captcha
        const inResp = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${page.url()}&json=1`);
        const inData = await inResp.json();
        if (inData.status !== 1) throw new Error("Erro 2Captcha: " + inData.request);

        const idRequest = inData.request;
        console.error(`[DETRAN] Resolvendo Captcha ID: ${idRequest}...`);

        // Espera ficar pronto (máximo ~2 minutos)
        let token = null;
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(3000);
            const resResp = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${idRequest}&json=1`);
            const resData = await resResp.json();
            if (resData.status === 1) {
                token = resData.request;
                break;
            }
            if (resData.request !== "CAPCHA_NOT_READY") {
                throw new Error("Erro 2Captcha: " + resData.request);
            }
        }

        if (!token) throw new Error("Timeout no Captcha (2 minutos).");
        console.error("[DETRAN] Token obtido! Injetando...");

        // Injeta o token na página
        await page.evaluate((t) => {
            const responseEl = document.getElementById("g-recaptcha-response");
            if (responseEl) {
                responseEl.innerHTML = t;
                responseEl.value = t;
                responseEl.style.display = "block"; // Necessário para alguns sites
            }
            // Tenta chamar callback do reCAPTCHA
            if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                try {
                    Object.values(window.___grecaptcha_cfg.clients).forEach(c => {
                        Object.values(c).forEach(k => {
                            if (k && typeof k === 'object') {
                                Object.values(k).forEach(v => {
                                    if (v && v.callback && typeof v.callback === 'function') {
                                        v.callback(t);
                                    }
                                });
                            }
                        });
                    });
                } catch(e) { console.log("Callback reCAPTCHA:", e); }
            }
        }, token);

        await page.waitForTimeout(500);
    } else {
        console.error("[DETRAN] Nenhum Captcha detectado, prosseguindo...");
    }

    // 5. ENVIAR (Botão btPesquisar)
    console.error("[DETRAN] Clicando em CONSULTAR...");
    
    // Clica via JS para garantir
    await page.evaluate(() => {
        const btn = document.getElementById("btPesquisar");
        if (btn) btn.click();
    });

    console.error("[DETRAN] Aguardando resultado...");
    
    // Espera networkidle para garantir que o resultado carregou
    await page.waitForLoadState('networkidle', { timeout: 45000 });

    // Espera adicional para garantir renderização
    await page.waitForTimeout(2000);

    // Verifica se deu erro na tela
    const erroNaTela = await page.evaluate(() => {
        const el = document.querySelector(".alert-danger, font[color='red'], .error-message, .mensagem-erro");
        return el ? el.innerText.trim() : null;
    });

    if (erroNaTela) throw new Error("DETRAN respondeu: " + erroNaTela);

    // 6. VERIFICAR SE HÁ BOTÃO DE EXTRATO DETALHADO
    // Conforme regra de negócio: verificar se existe botão para emitir extrato
    console.error("[DETRAN] Verificando se há extrato detalhado disponível...");
    const temExtrato = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
        const extrato = links.find(el => {
            const texto = (el.innerText || el.value || '').toLowerCase();
            return texto.includes('extrato') || texto.includes('detalhado') || texto.includes('emitir');
        });
        if (extrato) {
            extrato.click();
            return true;
        }
        return false;
    });

    if (temExtrato) {
        console.error("[DETRAN] Botão de extrato encontrado e clicado. Aguardando...");
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        await page.waitForTimeout(2000);
    }

    // 7. GERAR PDF
    console.error("[DETRAN] Gerando PDF final...");
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    
    console.error("[DETRAN] PDF gerado com sucesso!");
    return pdfBuffer;

  } catch (error) {
    console.error(`[DETRAN] ERRO FINAL: ${error.message}`);
    if (page) {
        try { await page.screenshot({ path: '/tmp/erro_detran.png', fullPage: true }); } catch(e){}
    }
    throw error;
  } finally {
    if (browser) {
        try { await browser.close(); } catch(e) {}
    }
  }
}

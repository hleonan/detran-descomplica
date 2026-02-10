import { chromium } from "playwright";
import fs from "fs";

// URLs mapeadas conforme sua navegação
const MENU_URL = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";

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
            '--disable-blink-features=AutomationControlled', // Esconde que é robô
            '--window-size=1366,768', // Tamanho fixo é melhor que maximized em headless
            '--disable-dev-shm-usage', // Evita crash de memória no Docker
            '--disable-gpu'
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

    // Headers para parecer que veio do Google
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.detran.rj.gov.br/' 
    });

    // 2. NAVEGAÇÃO REAL (Menu -> Serviço)
    // Entrar pelo Menu evita bloqueios de acesso direto
    console.error(`[DETRAN] Acessando menu: ${MENU_URL}`);
    await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    console.error("[DETRAN] Procurando link 'Nada Consta'...");
    
    // Tenta clicar no link exato que você mandou
    const linkClicado = await page.evaluate(() => {
        // Procura por href que contém "nada-consta.html"
        const links = Array.from(document.querySelectorAll('a'));
        const target = links.find(a => a.href.includes('nada-consta.html'));
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
        // Fallback: Acesso direto mas com Referer configurado
        await page.goto("https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html", {
            referer: MENU_URL // Digo pro site que vim do menu
        });
    }

    // 3. PREENCHIMENTO DO FORMULÁRIO (Com os IDs que você confirmou)
    console.error("[DETRAN] Procurando campos de CPF/CNH...");
    
    // Espera inteligente pelos IDs confirmados
    await page.waitForSelector("#CertidaoCpf", { state: 'visible', timeout: 30000 });
    console.error("[DETRAN] Campos encontrados!");

    // Digita devagar como um humano
    await page.type("#CertidaoCpf", cpfFormatted, { delay: 100 });
    await page.type("#CertidaoCnh", cnhFormatted, { delay: 100 });
    console.error("[DETRAN] Dados preenchidos.");

    // 4. RESOLVER CAPTCHA (Recaptcha V2)
    console.error("[DETRAN] Verificando Captcha...");
    
    // Procura o iframe do Recaptcha
    const frameElement = await page.$('iframe[src*="recaptcha/api2/anchor"]');
    if (frameElement) {
        console.error("[DETRAN] Captcha detectado. Quebrando...");
        
        // Pega a URL do iframe para extrair a sitekey (parâmetro 'k')
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

        // Espera ficar pronto
        let token = null;
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(3000);
            const resResp = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${idRequest}&json=1`);
            const resData = await resResp.json();
            if (resData.status === 1) {
                token = resData.request;
                break;
            }
        }

        if (!token) throw new Error("Timeout no Captcha.");
        console.error("[DETRAN] Token obtido! Injetando...");

        // Injeta o token na página
        await page.evaluate((t) => {
            document.getElementById("g-recaptcha-response").innerHTML = t;
            document.getElementById("g-recaptcha-response").value = t;
            // Tenta chamar callback se houver
            if(window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                Object.values(window.___grecaptcha_cfg.clients).forEach(c => {
                    Object.values(c).forEach(k => k.callback && k.callback(t));
                });
            }
        }, token);
    }

    // 5. ENVIAR (Botão btPesquisar)
    console.error("[DETRAN] Clicando em CONSULTAR...");
    
    // Clica e espera navegação ou erro
    // Tenta clicar via JS para garantir (alguns botões são chatos)
    await page.evaluate(() => document.getElementById("btPesquisar").click());

    console.error("[DETRAN] Aguardando resultado...");
    
    // Espera networkidle para garantir que o PDF ou erro carregou
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // Verifica se deu erro na tela
    const erroNaTela = await page.evaluate(() => {
        const el = document.querySelector(".alert-danger, font[color='red']");
        return el ? el.innerText : null;
    });

    if (erroNaTela) throw new Error("DETRAN respondeu: " + erroNaTela);

    // 6. GERAR PDF
    console.error("[DETRAN] Gerando PDF final...");
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    
    return pdfBuffer;

  } catch (error) {
    console.error(`[DETRAN] ERRO FINAL: ${error.message}`);
    if (page) {
        try { await page.screenshot({ path: '/tmp/erro_detran.png' }); } catch(e){}
    }
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

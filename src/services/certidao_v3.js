import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DETRAN_URL = "https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] Iniciando fluxo de emissão de certidão v3...");

  // Validar entrada
  if (!cpf || !cnh) {
    throw new Error("CPF e CNH são obrigatórios");
  }

  const cpfFormatted = cpf.replace(/\D/g, "");
  const cnhFormatted = cnh.replace(/\D/g, "");

  if (cpfFormatted.length !== 11 || cnhFormatted.length < 9) {
    throw new Error("Dados inválidos (CPF deve ter 11 dígitos)");
  }

  console.error("[DETRAN] CPF: " + cpfFormatted + " | CNH: " + cnhFormatted);

  // Verificar chaves de API
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) {
    throw new Error("TWOCAPTCHA_API_KEY não configurada");
  }
  console.error("[DETRAN] TWOCAPTCHA_API_KEY configurada ✓");

  let browser;
  let page;

  try {
    // Iniciar Chromium
    console.error("[DETRAN] Iniciando Chromium...");
    browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    console.error("[DETRAN] Chromium iniciado ✓");

    // Criar contexto e página (CORRIGIDO: newContext em vez de createContext)
    console.error("[DETRAN] Criando contexto do navegador...");
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    page = await context.newPage();
    console.error("[DETRAN] Página criada ✓");

    // Acessar página do DETRAN
    console.error("[DETRAN] Abrindo página do DETRAN...");
    await page.goto(DETRAN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.error("[DETRAN] Página carregada ✓");

    // Aguardar campo CPF estar visível
    console.error("[DETRAN] Aguardando campos...");
    await page.waitForSelector("#CertidaoCpf", { state: 'visible', timeout: 60000 });
    await page.waitForSelector("#CertidaoCnh", { state: 'visible', timeout: 60000 });
    console.error("[DETRAN] Campos encontrados ✓");

    // Preencher CPF
    console.error("[DETRAN] Preenchendo CPF...");
    await page.fill("#CertidaoCpf", cpfFormatted);
    await page.waitForTimeout(500);

    // Preencher CNH
    console.error("[DETRAN] Preenchendo CNH...");
    await page.fill("#CertidaoCnh", cnhFormatted);
    await page.waitForTimeout(500);

    // Verificar reCAPTCHA
    console.error("[DETRAN] Verificando reCAPTCHA...");
    // Tenta encontrar o iframe do recaptcha para pegar a sitekey
    const recaptchaFrame = await page.$('iframe[src*="recaptcha/api2/anchor"]');
    
    if (recaptchaFrame) {
      console.error("[DETRAN] reCAPTCHA encontrado, resolvendo...");
      
      const src = await recaptchaFrame.getAttribute("src");
      const urlParams = new URLSearchParams(src.split("?")[1]);
      const sitekey = urlParams.get("k");

      if (!sitekey) throw new Error("Não consegui extrair sitekey do reCAPTCHA");

      // Envia para o 2Captcha
      const captchaResponse = await fetch("http://2captcha.com/in.php", {
        method: "POST",
        body: new URLSearchParams({
          method: "userrecaptcha",
          googlekey: sitekey,
          pageurl: DETRAN_URL,
          key: twocaptchaKey,
          json: 1
        }),
      });
      
      const captchaData = await captchaResponse.json();
      if (captchaData.status !== 1) throw new Error("Erro ao enviar para 2Captcha: " + captchaData.request);
      
      const captchaId = captchaData.request;
      console.error(`[DETRAN] Captcha enviado (ID: ${captchaId}). Aguardando resposta...`);

      let token = null;
      for (let i = 0; i < 40; i++) { // Tenta por ~2 minutos
        await page.waitForTimeout(3000);
        const resultResponse = await fetch(
          `http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${captchaId}&json=1`
        );
        const result = await resultResponse.json();

        if (result.status === 1) {
          token = result.request;
          break;
        }
        if (result.request !== "CAPCHA_NOT_READY") {
            throw new Error("Erro no 2Captcha: " + result.request);
        }
      }

      if (!token) throw new Error("Timeout ao resolver o reCAPTCHA");

      console.error("[DETRAN] Token obtido! Injetando...");

      // Injetar token na página (método universal)
      await page.evaluate((token) => {
        const el = document.querySelector('[name="g-recaptcha-response"]');
        if(el) { 
            el.innerHTML = token;
            el.value = token;
        }
        // Tenta chamar o callback se existir (comum em detrans)
        if(window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
             Object.values(window.___grecaptcha_cfg.clients).forEach(client => {
                 Object.values(client).forEach(obj => {
                     if(obj && obj.callback) obj.callback(token);
                 });
             });
        }
      }, token);

      await page.waitForTimeout(1000);
    } else {
      console.error("[DETRAN] reCAPTCHA não detectado visivelmente. Tentando seguir...");
    }

    // Clicar no botão CONSULTAR
    console.error("[DETRAN] Clicando em Consultar...");
    // Tenta diferentes seletores para garantir
    const btnSelector = "#btPesquisar";
    await page.waitForSelector(btnSelector, { state: 'attached' });
    
    // Força clique via JS para evitar problemas de overlay
    await page.evaluate((sel) => {
        document.querySelector(sel).click();
    }, btnSelector);

    // Aguardar resultado (PDF ou Mensagem de Erro)
    console.error("[DETRAN] Aguardando resposta...");
    
    // Espera navegar OU aparecer mensagem de erro
    try {
        await Promise.race([
            page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }),
            page.waitForSelector('.alert-danger, .error-message', { timeout: 15000 })
        ]);
    } catch(e) {
        console.log("Navegação demorou ou não ocorreu, verificando estado atual...");
    }

    // Verifica se deu erro na tela
    const erroTexto = await page.evaluate(() => {
        const el = document.querySelector('.alert-danger, font[color="red"]');
        return el ? el.innerText : null;
    });

    if (erroTexto) {
        throw new Error("DETRAN retornou: " + erroTexto);
    }

    console.error("[DETRAN] Gerando PDF do resultado...");
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    console.error("[DETRAN] ✅ PDF gerado com sucesso!");

    return pdfBuffer;

  } catch (error) {
    console.error(`[DETRAN] ❌ Erro Crítico: ${error.message}`);
    // Salva print do erro se possível
    if(page) {
        try {
            await page.screenshot({ path: '/tmp/detran_erro_final.png' });
            console.error("Screenshot de erro salvo em /tmp/detran_erro_final.png");
        } catch(e) {}
    }
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

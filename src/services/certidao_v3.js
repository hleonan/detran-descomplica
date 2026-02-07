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

  if (cpfFormatted.length !== 11 || cnhFormatted.length !== 11) {
    throw new Error("CPF e CNH devem ter 11 dígitos");
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
    browser = await chromium.launch({ headless: true });
    console.error("[DETRAN] Chromium iniciado ✓");

    // Criar contexto e página
    console.error("[DETRAN] Criando contexto do navegador...");
    const context = await browser.createContext();
    page = await context.newPage();
    console.error("[DETRAN] Página criada ✓");

    // Acessar página do DETRAN
    console.error("[DETRAN] Abrindo página do DETRAN...");
    await page.goto(DETRAN_URL, { waitUntil: "networkidle", timeout: 60000 });
    console.error("[DETRAN] Página carregada ✓");

    // Aguardar carregamento completo
    console.error("[DETRAN] Aguardando carregamento completo da página...");
    await page.waitForLoadState("networkidle", { timeout: 60000 });
    console.error("[DETRAN] Página pronta ✓");

    // Scroll para o formulário
    console.error("[DETRAN] Scrollando para o formulário...");
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) form.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    await page.waitForTimeout(2000);
    console.error("[DETRAN] Scroll concluído ✓");

    // Aguardar campo CPF estar visível
    console.error("[DETRAN] Aguardando campo CPF (CertidaoCpf) estar visível...");
    await page.waitForSelector("#CertidaoCpf", { timeout: 60000 });
    console.error("[DETRAN] Campo CPF encontrado ✓");

    // Aguardar campo CNH estar visível
    console.error("[DETRAN] Aguardando campo CNH (CertidaoCnh) estar visível...");
    await page.waitForSelector("#CertidaoCnh", { timeout: 60000 });
    console.error("[DETRAN] Campo CNH encontrado ✓");

    // Aguardar que os campos estejam realmente visíveis e habilitados
    console.error("[DETRAN] Aguardando campos estarem habilitados...");
    await page.waitForFunction(
      () => {
        const cpfField = document.querySelector("#CertidaoCpf");
        const cnhField = document.querySelector("#CertidaoCnh");
        return (
          cpfField &&
          cnhField &&
          !cpfField.disabled &&
          !cnhField.disabled &&
          cpfField.offsetParent !== null &&
          cnhField.offsetParent !== null
        );
      },
      { timeout: 60000 }
    );
    console.error("[DETRAN] Campos habilitados ✓");

    // Preencher CPF
    console.error("[DETRAN] Preenchendo CPF...");
    await page.fill("#CertidaoCpf", cpfFormatted);
    await page.waitForTimeout(1000);
    console.error("[DETRAN] CPF preenchido ✓");

    // Preencher CNH
    console.error("[DETRAN] Preenchendo CNH...");
    await page.fill("#CertidaoCnh", cnhFormatted);
    await page.waitForTimeout(1000);
    console.error("[DETRAN] CNH preenchida ✓");

    // Verificar reCAPTCHA
    console.error("[DETRAN] Procurando reCAPTCHA...");
    const recaptchaPresent = await page.locator("#recaptcha-anchor").isVisible().catch(() => false);
    
    if (recaptchaPresent) {
      console.error("[DETRAN] reCAPTCHA encontrado, resolvendo...");
      
      // Obter token do reCAPTCHA
      console.error("[DETRAN] Enviando para 2Captcha...");
      const sitekey = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="recaptcha"]');
        if (iframe) {
          const src = iframe.getAttribute("src");
          const match = src.match(/k=([^&]+)/);
          return match ? match[1] : null;
        }
        return null;
      });

      if (!sitekey) {
        throw new Error("Não consegui extrair sitekey do reCAPTCHA");
      }

      const captchaResponse = await fetch("http://2captcha.com/api/captcha", {
        method: "POST",
        body: new URLSearchParams({
          method: "userrecaptcha",
          googlekey: sitekey,
          pageurl: DETRAN_URL,
          apikey: twocaptchaKey,
        }),
      });

      const captchaText = await captchaResponse.text();
      const captchaId = captchaText.split("|")[1];

      if (!captchaId) {
        throw new Error("Erro ao enviar para 2Captcha: " + captchaText);
      }

      console.error("[DETRAN] Aguardando resposta do 2Captcha...");
      let token = null;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        const resultResponse = await fetch(
          `http://2captcha.com/api/res?key=${twocaptchaKey}&action=get&captchaid=${captchaId}&json=1`
        );
        const result = await resultResponse.json();

        if (result.status === 0 && result.request) {
          token = result.request;
          break;
        }
      }

      if (!token) {
        throw new Error("Não consegui resolver o reCAPTCHA");
      }

      console.error("[DETRAN] Token reCAPTCHA obtido ✓");

      // Injetar token no reCAPTCHA
      console.error("[DETRAN] Injetando token no reCAPTCHA...");
      await page.evaluate((token) => {
        window.grecaptcha.callback = function () {
          document.getElementById("g-recaptcha-response").innerHTML = token;
          if (window.___grecaptcha_cfg) {
            Object.entries(window.___grecaptcha_cfg.clients).forEach(([key, client]) => {
              if (client.callback) {
                client.callback(token);
              }
            });
          }
        };
        document.getElementById("g-recaptcha-response").innerHTML = token;
      }, token);

      await page.waitForTimeout(1000);
      console.error("[DETRAN] Token injetado ✓");
    } else {
      console.error("[DETRAN] reCAPTCHA não encontrado (pode estar desabilitado)");
    }

    // Procurar e clicar no botão CONSULTAR
    console.error("[DETRAN] Procurando botão CONSULTAR...");
    const submitBtn = await page.locator("#btPesquisar").isVisible().catch(() => false);
    
    if (!submitBtn) {
      throw new Error("Botão CONSULTAR não encontrado");
    }

    console.error("[DETRAN] Botão encontrado, clicando...");
    await page.click("#btPesquisar");
    console.error("[DETRAN] Clique realizado ✓");

    // Aguardar resultado
    console.error("[DETRAN] Aguardando resultado da consulta...");
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }).catch(() => {
      // Pode não haver navegação, apenas mudança de conteúdo
    });
    await page.waitForTimeout(3000);
    console.error("[DETRAN] Resultado recebido ✓");

    // Gerar PDF
    console.error("[DETRAN] Gerando PDF...");
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    console.error("[DETRAN] ✅ PDF gerado com sucesso!");

    // Salvar screenshot para debug
    const timestamp = Date.now();
    const screenshotPath = `/tmp/detran_${timestamp}_success.png`;
    await page.screenshot({ path: screenshotPath });
    console.error(`[DETRAN] Screenshot salvo em ${screenshotPath}`);

    console.error("[DETRAN] ✅ Certidão emitida com sucesso!");

    return pdfBuffer;
  } catch (error) {
    console.error(`[DETRAN] ❌ Erro: ${error.message}`);

    // Salvar screenshot de erro
    if (page) {
      const timestamp = Date.now();
      const screenshotPath = `/tmp/detran_${timestamp}_error.png`;
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      console.error(`[DETRAN] Screenshot de erro salvo em ${screenshotPath}`);

      // Salvar HTML para análise
      const htmlPath = `/tmp/detran_${timestamp}_error.html`;
      const html = await page.content().catch(() => "");
      if (html) fs.writeFileSync(htmlPath, html);
      console.error(`[DETRAN] HTML salvo em ${htmlPath}`);
    }

    throw error;
  } finally {
    // Fechar navegador
    console.error("[DETRAN] Fechando navegador...");
    if (browser) await browser.close();
    console.error("[DETRAN] Navegador fechado ✓");
  }
}

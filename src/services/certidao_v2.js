// src/services/certidao.js - VERSÃO MELHORADA COM DEBUG
import { chromium } from "playwright";
import fs from "fs";

const DETRAN_HOME = "https://www.detran.rj.gov.br/";
const MENU_INFRACOES = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";
const NADA_CONSTA_URL =
  "https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html";

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ DEBUG MELHORADO
async function dumpDebugDetalhado(page, label) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    
    // Log detalhado
    console.error(`\n[DETRAN DEBUG] ========== ${label} ==========`);
    console.error(`[DETRAN DEBUG] URL: ${url}`);
    console.error(`[DETRAN DEBUG] Title: ${title}`);
    console.error(`[DETRAN DEBUG] HTML Size: ${html.length}`);
    
    // Procura por elementos importantes
    const cpfField = await page.locator("#CertidaoCpf").count().catch(() => 0);
    const cnhField = await page.locator("#CertidaoCnh").count().catch(() => 0);
    const btnPesquisar = await page.locator("#btPesquisar").count().catch(() => 0);
    
    console.error(`[DETRAN DEBUG] #CertidaoCpf encontrado: ${cpfField > 0}`);
    console.error(`[DETRAN DEBUG] #CertidaoCnh encontrado: ${cnhField > 0}`);
    console.error(`[DETRAN DEBUG] #btPesquisar encontrado: ${btnPesquisar > 0}`);
    
    // Procura por formulários
    const forms = await page.locator("form").count().catch(() => 0);
    console.error(`[DETRAN DEBUG] Total de formulários: ${forms}`);
    
    // Procura por inputs
    const inputs = await page.locator("input[type='text']").count().catch(() => 0);
    console.error(`[DETRAN DEBUG] Total de inputs text: ${inputs}`);
    
    // Salva screenshot
    const shotPath = `/tmp/detran_${Date.now()}_${label}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    console.error(`[DETRAN DEBUG] Screenshot: ${shotPath}`);
    
    // Salva HTML para análise
    const htmlPath = `/tmp/detran_${Date.now()}_${label}.html`;
    fs.writeFileSync(htmlPath, html);
    console.error(`[DETRAN DEBUG] HTML: ${htmlPath}`);
    
    console.error(`[DETRAN DEBUG] ========== FIM ==========\n`);
  } catch (e) {
    console.error("[DETRAN DEBUG] dump failed:", e?.message || e);
  }
}

// 2Captcha reCAPTCHA v2
async function solveRecaptchaV2({ apiKey, siteKey, pageUrl }) {
  const inParams = new URLSearchParams({
    key: apiKey,
    method: "userrecaptcha",
    googlekey: siteKey,
    pageurl: pageUrl,
    json: "1",
  });

  const inResp = await fetch(`https://2captcha.com/in.php?${inParams.toString()}`);
  const inData = await inResp.json();

  if (!inData || inData.status !== 1) {
    throw new Error(`2Captcha in.php erro: ${inData?.request || "resposta inválida"}`);
  }

  const requestId = inData.request;
  const start = Date.now();

  while (true) {
    await sleep(5000);

    const resParams = new URLSearchParams({
      key: apiKey,
      action: "get",
      id: requestId,
      json: "1",
    });

    const resResp = await fetch(`https://2captcha.com/res.php?${resParams.toString()}`);
    const resData = await resResp.json();

    if (resData?.status === 1) return resData.request;

    const msg = String(resData?.request || "");
    if (msg !== "CAPCHA_NOT_READY") throw new Error(`2Captcha res.php erro: ${msg}`);

    if (Date.now() - start > 120000) throw new Error("2Captcha timeout (demorou > 2 min)");
  }
}

async function findRecaptchaSiteKey(page) {
  // tenta na página
  let siteKey = await page
    .evaluate(() => {
      const el = document.querySelector(".g-recaptcha");
      return el ? el.getAttribute("data-sitekey") : null;
    })
    .catch(() => null);

  if (siteKey) return siteKey;

  // tenta em iframes
  for (const fr of page.frames()) {
    siteKey = await fr
      .evaluate(() => {
        const el = document.querySelector(".g-recaptcha");
        return el ? el.getAttribute("data-sitekey") : null;
      })
      .catch(() => null);
    if (siteKey) return siteKey;
  }

  return null;
}

// ✅ NOVO FLUXO COM MELHOR DEBUG
async function gotoViaMenuInfracoesV2(page) {
  console.log("[DETRAN] Iniciando fluxo de navegação...");
  
  // 1. Vai para HOME
  console.log("[DETRAN] 1. Navegando para HOME...");
  await page.goto(DETRAN_HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
  await dumpDebugDetalhado(page, "apos_home");
  
  // 2. Vai para MENU de Infrações
  console.log("[DETRAN] 2. Navegando para MENU de Infrações...");
  await page.goto(MENU_INFRACOES, { waitUntil: "domcontentloaded", timeout: 60000 });
  await dumpDebugDetalhado(page, "apos_menu_infracoes");
  
  // 3. Tenta clicar no link "Emitir Certidão"
  console.log("[DETRAN] 3. Procurando link 'Emitir Certidão'...");
  const linkEmitir = page.locator('a:has-text("Emitir Certidão")').first();
  const linkCount = await linkEmitir.count().catch(() => 0);
  
  if (linkCount > 0) {
    console.log("[DETRAN] Link encontrado! Clicando...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      linkEmitir.click({ timeout: 10000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(2000);
    await dumpDebugDetalhado(page, "apos_clicar_emitir");
  } else {
    console.log("[DETRAN] Link não encontrado. Tentando fallback direto...");
    await page.goto(NADA_CONSTA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dumpDebugDetalhado(page, "apos_fallback_direto");
  }
  
  // 4. Garante que chegou na URL correta
  const currentUrl = page.url();
  console.log(`[DETRAN] URL atual: ${currentUrl}`);
  
  if (!currentUrl.includes("nada-consta")) {
    console.log("[DETRAN] URL não contém 'nada-consta'. Forçando navegação direta...");
    await page.goto(NADA_CONSTA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await dumpDebugDetalhado(page, "apos_forca_nada_consta");
  }
  
  console.log("[DETRAN] Fluxo de navegação concluído!");
}

// ✅ VALIDAÇÃO DE CAMPOS
async function validarCamposExistem(page) {
  console.log("[DETRAN] Validando campos do formulário...");
  
  const cpfField = await page.locator("#CertidaoCpf").count().catch(() => 0);
  const cnhField = await page.locator("#CertidaoCnh").count().catch(() => 0);
  const btnPesquisar = await page.locator("#btPesquisar").count().catch(() => 0);
  
  console.log(`[DETRAN] #CertidaoCpf: ${cpfField}`);
  console.log(`[DETRAN] #CertidaoCnh: ${cnhField}`);
  console.log(`[DETRAN] #btPesquisar: ${btnPesquisar}`);
  
  if (cpfField === 0) {
    console.error("[DETRAN] ❌ Campo CPF não encontrado!");
    await dumpDebugDetalhado(page, "erro_campo_cpf");
    throw new Error("Campo CPF (#CertidaoCpf) não encontrado na página");
  }
  
  if (cnhField === 0) {
    console.error("[DETRAN] ❌ Campo CNH não encontrado!");
    await dumpDebugDetalhado(page, "erro_campo_cnh");
    throw new Error("Campo CNH (#CertidaoCnh) não encontrado na página");
  }
  
  if (btnPesquisar === 0) {
    console.error("[DETRAN] ❌ Botão Pesquisar não encontrado!");
    await dumpDebugDetalhado(page, "erro_botao_pesquisar");
    throw new Error("Botão Pesquisar (#btPesquisar) não encontrado na página");
  }
  
  console.log("[DETRAN] ✅ Todos os campos encontrados!");
}

export async function emitirCertidaoPDF({ cpf, cnh }) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) throw new Error("TWOCAPTCHA_API_KEY não configurada");

  const cpfDigits = onlyDigits(cpf);
  const cnhDigits = onlyDigits(cnh);

  if (cpfDigits.length !== 11) throw new Error("CPF inválido");
  if (cnhDigits.length < 9) throw new Error("CNH inválida");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });

    const page = await context.newPage();

    // ✅ abre pelo caminho humano (mais estável)
    await gotoViaMenuInfracoesV2(page);
    
    // ✅ Valida se os campos existem
    await validarCamposExistem(page);

    // ✅ Preenche com os seletores corretos
    console.log("[DETRAN] Preenchendo formulário...");
    await page.locator("#CertidaoCpf").first().fill(cpfDigits);
    await page.locator("#CertidaoCnh").first().fill(cnhDigits);
    console.log("[DETRAN] Formulário preenchido!");

    // ✅ reCAPTCHA v2: pega sitekey e resolve no 2captcha
    console.log("[DETRAN] Resolvendo reCAPTCHA...");
    const siteKey = await findRecaptchaSiteKey(page);
    if (!siteKey) {
      await dumpDebugDetalhado(page, "no_sitekey");
      throw new Error("Não achei o sitekey do reCAPTCHA (g-recaptcha).");
    }

    const token = await solveRecaptchaV2({
      apiKey,
      siteKey,
      pageUrl: page.url(),
    });
    console.log("[DETRAN] reCAPTCHA resolvido!");

    // injeta token
    await page.evaluate((tkn) => {
      const area =
        document.querySelector('textarea[name="g-recaptcha-response"]') ||
        document.querySelector("#g-recaptcha-response");
      if (!area) throw new Error("Não achei g-recaptcha-response");
      area.style.display = "block";
      area.value = tkn;
      area.dispatchEvent(new Event("input", { bubbles: true }));
      area.dispatchEvent(new Event("change", { bubbles: true }));
    }, token);

    // ✅ Clica no botão correto
    console.log("[DETRAN] Clicando em Pesquisar...");
    const btn = page.locator("#btPesquisar").first();
    const btnCount = await btn.count().catch(() => 0);
    if (btnCount === 0) {
      await dumpDebugDetalhado(page, "no_btPesquisar");
      throw new Error("Não achei o botão CONSULTAR (btPesquisar).");
    }

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {}),
      btn.click({ timeout: 10000 }).catch(() => {}),
    ]);

    await page.waitForTimeout(1500);
    console.log("[DETRAN] Gerando PDF...");

    // ✅ PDF do resultado
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });

    console.log("[DETRAN] ✅ PDF gerado com sucesso!");
    await context.close().catch(() => {});
    return pdfBuffer;
  } catch (err) {
    console.error("[DETRAN] ❌ Erro ao emitir certidão:", err?.message || err);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

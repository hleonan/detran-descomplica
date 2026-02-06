// src/services/certidao.js
import { chromium } from "playwright";

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

async function dumpDebug(page, label) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    console.error(`[DETRAN DEBUG] ${label} url=${url} title=${title} htmlSize=${html.length}`);

    const shotPath = `/tmp/detran_${Date.now()}_${label}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    console.error(`[DETRAN DEBUG] screenshot saved at ${shotPath}`);

    console.error(`[DETRAN DEBUG] htmlHead:\n${html.slice(0, 1500)}`);
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

async function gotoViaMenuInfracoes(page) {
  // caminho "humano": HOME -> menu infrações -> emitir certidão
  await page.goto(DETRAN_HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.goto(MENU_INFRACOES, { waitUntil: "domcontentloaded", timeout: 60000 });

  // tenta clicar “Emitir Certidão de Nada Consta” se existir
  const linkEmitir = page.locator('a:has-text("Emitir Certidão")').first();
  const count = await linkEmitir.count().catch(() => 0);

  if (count > 0) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      linkEmitir.click({ timeout: 10000 }).catch(() => {}),
    ]);
  } else {
    // fallback direto
    await page.goto(NADA_CONSTA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  // garante URL final
  if (!page.url().includes("nada-consta")) {
    await page.goto(NADA_CONSTA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  await page.waitForTimeout(1500);
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
    await gotoViaMenuInfracoes(page);

    // ✅ Agora: espere pelos campos REAIS do DETRAN
    // CPF: id CertidaoCpf
    // CNH: id CertidaoCnh
    await page.waitForSelector("#CertidaoCpf", { timeout: 30000 }).catch(async () => {
      await dumpDebug(page, "no_CertidaoCpf");
      throw new Error("Não achei o campo CPF (CertidaoCpf) na página do DETRAN");
    });

    await page.waitForSelector("#CertidaoCnh", { timeout: 30000 }).catch(async () => {
      await dumpDebug(page, "no_CertidaoCnh");
      throw new Error("Não achei o campo CNH (CertidaoCnh) na página do DETRAN");
    });

    // ✅ Preenche com os seletores corretos
    await page.locator("#CertidaoCpf").first().fill(cpfDigits);
    await page.locator("#CertidaoCnh").first().fill(cnhDigits);

    // ✅ reCAPTCHA v2: pega sitekey e resolve no 2captcha
    const siteKey = await findRecaptchaSiteKey(page);
    if (!siteKey) {
      await dumpDebug(page, "no_sitekey");
      throw new Error("Não achei o sitekey do reCAPTCHA (g-recaptcha).");
    }

    const token = await solveRecaptchaV2({
      apiKey,
      siteKey,
      pageUrl: page.url(),
    });

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
    const btn = page.locator("#btPesquisar").first();
    const btnCount = await btn.count().catch(() => 0);
    if (btnCount === 0) {
      await dumpDebug(page, "no_btPesquisar");
      throw new Error("Não achei o botão CONSULTAR (btPesquisar).");
    }

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {}),
      btn.click({ timeout: 10000 }).catch(() => {}),
    ]);

    await page.waitForTimeout(1500);

    // ✅ PDF do resultado
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });

    await context.close().catch(() => {});
    return pdfBuffer;
  } finally {
    await browser.close().catch(() => {});
  }
}

// src/services/certidao.js
import { chromium } from "playwright";

const DETRAN_URL =
  "https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html";

function onlyDigits(v = "") {
  return String(v).replace(/\D/g, "");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 2Captcha reCAPTCHA v2
async function solveRecaptchaV2({ apiKey, siteKey, pageUrl }) {
  // 1) cria task
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

  // 2) poll resultado
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
    if (msg !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha res.php erro: ${msg}`);
    }

    if (Date.now() - start > 120000) {
      throw new Error("2Captcha timeout (demorou > 2 min)");
    }
  }
}

async function fillFirstMatch(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
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
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(DETRAN_URL, { waitUntil: "domcontentloaded" });

    // Preenche CPF/CNH (seletores robustos)
    const okCpf = await fillFirstMatch(
      page,
      [
        'input[name="cpf"]',
        "input#cpf",
        'input[name*="cpf" i]',
        'input[placeholder*="CPF" i]',
      ],
      cpfDigits
    );
    if (!okCpf) throw new Error("Não achei o campo CPF na página do DETRAN");

    const okCnh = await fillFirstMatch(
      page,
      [
        'input[name="cnh"]',
        "input#cnh",
        'input[name*="cnh" i]',
        'input[name*="registro" i]',
        'input[placeholder*="CNH" i]',
        'input[placeholder*="Registro" i]',
      ],
      cnhDigits
    );
    if (!okCnh) throw new Error("Não achei o campo CNH/Registro na página do DETRAN");

    // Pega sitekey do reCAPTCHA
    const siteKey = await page.evaluate(() => {
      const el = document.querySelector(".g-recaptcha");
      return el ? el.getAttribute("data-sitekey") : null;
    });

    if (!siteKey) {
      throw new Error("Não achei o reCAPTCHA (sitekey). Talvez o DETRAN mudou o captcha.");
    }

    // Resolve no 2Captcha
    const token = await solveRecaptchaV2({
      apiKey,
      siteKey,
      pageUrl: DETRAN_URL,
    });

    // Injeta token no g-recaptcha-response
    await page.evaluate((tkn) => {
      const area =
        document.querySelector('textarea[name="g-recaptcha-response"]') ||
        document.querySelector("#g-recaptcha-response");

      if (!area) throw new Error("Não achei g-recaptcha-response");
      area.style.display = "block";
      area.value = tkn;

      // dispara eventos pra alguns sites “sentirem” mudança
      area.dispatchEvent(new Event("input", { bubbles: true }));
      area.dispatchEvent(new Event("change", { bubbles: true }));
    }, token);

    // Clica no botão de consultar/emitir (robusto)
    const buttonCandidates = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Consultar")',
      'button:has-text("Emitir")',
      'button:has-text("Gerar")',
      'a:has-text("Consultar")',
    ];

    let clicked = false;
    for (const sel of buttonCandidates) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error("Não achei o botão de consultar/emitir na página do DETRAN");

    // Espera a página do resultado estabilizar
    await page.waitForLoadState("networkidle", { timeout: 45000 });

    // Gera PDF da página “resultado”
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

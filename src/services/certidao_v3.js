import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib"; // A Manus usava isso, é vital.

// URL Direta que a Manus descobriu ser a melhor
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] Iniciando automação (Modo Manus Restaurado)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH obrigatórios");
  
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Sem chave 2Captcha");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // 1. Acessa direto o iframe (Segredo da Manus)
    await page.goto(CERTIDAO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 2. Preenchimento
    await page.waitForSelector('#CertidaoCpf', { state: 'visible' });
    await page.fill('#CertidaoCpf', cpf.replace(/\D/g, ""));
    await page.fill('#CertidaoCnh', cnh.replace(/\D/g, ""));

    // 3. Captcha (Lógica da Manus/Mac)
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      console.log("[DETRAN] Resolvendo Captcha...");
      const src = await recaptchaFrame.getAttribute("src");
      const sitekey = new URLSearchParams(src.split("?")[1]).get("k");
      
      // Envia para 2Captcha
      const inRes = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${CERTIDAO_URL}&json=1`);
      const inData = await inRes.json();
      const id = inData.request;

      // Espera resultado
      let token = null;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(3000);
        const res = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${id}&json=1`);
        const data = await res.json();
        if (data.status === 1) { token = data.request; break; }
      }

      if (!token) throw new Error("Captcha Timeout");

      // Injeta token
      await page.evaluate((t) => {
        document.getElementById("g-recaptcha-response").innerHTML = t;
        if (window.___grecaptcha_cfg) {
             Object.values(window.___grecaptcha_cfg.clients).forEach(c => {
                 Object.values(c).forEach(k => k.callback && k.callback(t));
             });
        }
      }, token);
    }

    // 4. Consultar
    await page.click('#btPesquisar');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForTimeout(1000); // Segurança

    // ============================================================
    // A ÚNICA ALTERAÇÃO MINHA: VALIDAÇÃO DE ERRO (Trava de Segurança)
    // ============================================================
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());
    
    // Se o DETRAN reclamar, a gente aborta (para não gerar PDF falso)
    if (textoTela.includes("DADOS INFORMADOS INVÁLIDOS") || 
        textoTela.includes("NÃO CONFEREM") || 
        textoTela.includes("CAPTCHA INCORRETO")) {
        throw new Error("DETRAN_FAIL: Dados inválidos ou erro no site.");
    }
    // ============================================================

    // 5. Geração de PDF via Imagem (Lógica da Manus)
    // Isso evita que o PDF saia em branco ou desformatado
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    
    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(screenshot);
    const pagePdf = pdfDoc.addPage([pngImage.width, pngImage.height]);
    pagePdf.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });
    
    const pdfBytes = await pdfDoc.save();
    
    // Retorna o objeto completo que o seu API.js espera (analise + buffer)
    // A Manus retornava dados extras, vou simular para não quebrar o API.js
    return {
        pdfBuffer: Buffer.from(pdfBytes),
        analise: {
            temProblemas: textoTela.includes("OCORRÊNCIA") || textoTela.includes("CONSTA"),
            status: textoTela.includes("NADA CONSTA") ? "OK" : "RESTRICAO",
            motivo: textoTela.includes("OCORRÊNCIA") ? "Restrições encontradas" : "Nada Consta",
            nome: "Motorista (Via Certidão)", // O nome é difícil de extrair sem seletor específico
            dados: {}
        }
    };

  } finally {
    if (browser) await browser.close();
  }
}

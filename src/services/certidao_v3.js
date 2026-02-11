import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib"; 

// A URL "Mágica" da Manus (Direta e Rápida)
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] Iniciando automação (Modo Rápido - Manus)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");
  
  // Limpeza dos dados
  const cpfLimpo = cpf.replace(/\D/g, "");
  const cnhLimpo = cnh.replace(/\D/g, "");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Sem chave 2Captcha");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // 1. ACESSO DIRETO (Muito mais rápido que pelo menu)
    console.log("[DETRAN] Acessando URL Direta...");
    await page.goto(CERTIDAO_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 2. PREENCHIMENTO
    await page.waitForSelector('#CertidaoCpf', { state: 'visible', timeout: 30000 });
    await page.fill('#CertidaoCpf', cpfLimpo);
    await page.fill('#CertidaoCnh', cnhLimpo);

    // 3. CAPTCHA (Lógica Robusta)
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      console.log("[DETRAN] Resolvendo Captcha...");
      const src = await recaptchaFrame.getAttribute("src");
      const sitekey = new URLSearchParams(src.split("?")[1]).get("k");
      
      const inRes = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${CERTIDAO_URL}&json=1`);
      const inData = await inRes.json();
      const id = inData.request;

      let token = null;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(3000);
        const res = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${id}&json=1`);
        const data = await res.json();
        if (data.status === 1) { token = data.request; break; }
      }

      if (!token) throw new Error("Captcha Timeout");

      await page.evaluate((t) => {
        document.getElementById("g-recaptcha-response").innerHTML = t;
        // Tenta chamar callbacks do Detran se existirem
        if (window.___grecaptcha_cfg) {
             Object.values(window.___grecaptcha_cfg.clients).forEach(c => {
                 Object.values(c).forEach(k => k.callback && k.callback(t));
             });
        }
      }, token);
    }

    // 4. CONSULTAR
    console.log("[DETRAN] Clicando em pesquisar...");
    await page.click('#btPesquisar');
    
    // Espera a resposta (pode ser rápida ou lenta)
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForTimeout(1500); // Pequeno respiro para renderizar

    // ============================================================
    // TRAVA DE SEGURANÇA (Para não enganar o cliente)
    // ============================================================
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());
    
    // Lista de frases que significam "Não deu certo"
    if (textoTela.includes("DADOS INFORMADOS INVÁLIDOS") || 
        textoTela.includes("NÃO CONFEREM") || 
        textoTela.includes("CAPTCHA INCORRETO") ||
        textoTela.includes("ERRO NA CONSULTA")) {
        
        console.error(`[DETRAN] Erro na tela: ${textoTela.substring(0, 50)}...`);
        // Lança erro específico que o Front-end vai pegar para mostrar o WhatsApp
        throw new Error("DETRAN_FAIL: O site recusou os dados. Verifique CPF/CNH.");
    }
    // ============================================================

    // 5. GERAÇÃO DO PDF (Método da Manus - Screenshot)
    // Esse método é melhor porque captura exatamente o visual da certidão
    console.log("[DETRAN] Gerando PDF visual...");
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    
    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(screenshot);
    
    // Cria página do tamanho da imagem
    const pagePdf = pdfDoc.addPage([pngImage.width, pngImage.height]);
    pagePdf.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });
    
    const pdfBytes = await pdfDoc.save();
    
    // Retorna Buffer
    return Buffer.from(pdfBytes);

  } catch (error) {
    console.error(`[DETRAN] ERRO FATAL: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

// URL oficial do relatório da Manus
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

export async function emitirCertidaoPDF(cpf, cnh) {
  // Validação básica
  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");
  
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Sem chave 2Captcha");

  let browser;
  try {
    // 1. CONFIGURAÇÃO PADRÃO (Igual ao que funcionava antes)
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

    console.log(`[DETRAN] Conectando em ${CERTIDAO_URL}...`);

    // ==================================================================
    // A ÚNICA MUDANÇA TÉCNICA (Correção do Timeout)
    // Usamos 'commit' em vez de 'domcontentloaded' para não travar
    // ==================================================================
    await page.goto(CERTIDAO_URL, { waitUntil: 'commit', timeout: 60000 });
    
    // Espera explícita pelo formulário (Garante que carregou)
    console.log("[DETRAN] Aguardando campo de CPF...");
    await page.waitForSelector('#CertidaoCpf', { state: 'visible', timeout: 60000 });

    // 2. PREENCHIMENTO
    await page.fill('#CertidaoCpf', cpf.replace(/\D/g, ""));
    await page.fill('#CertidaoCnh', cnh.replace(/\D/g, ""));

    // 3. CAPTCHA
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      console.log("[DETRAN] Resolvendo Captcha...");
      const src = await recaptchaFrame.getAttribute("src");
      const sitekey = new URLSearchParams(src.split("?")[1]).get("k");
      
      const inRes = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${CERTIDAO_URL}&json=1`);
      const inData = await inRes.json();
      const id = inData.request;

      let token = null;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(3000);
        const res = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${id}&json=1`);
        const data = await res.json();
        if (data.status === 1) { token = data.request; break; }
      }

      if (!token) throw new Error("Captcha Timeout");

      await page.evaluate((t) => {
        document.getElementById("g-recaptcha-response").innerHTML = t;
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
    
    // Aguarda a resposta do servidor
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(1000); 

    // ==================================================================
    // VALIDAÇÃO DE ERRO (Sua solicitação do WhatsApp)
    // ==================================================================
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());
    
    if (textoTela.includes("DADOS INFORMADOS INVÁLIDOS") || 
        textoTela.includes("NÃO CONFEREM") || 
        textoTela.includes("CAPTCHA INCORRETO")) {
        throw new Error("DETRAN_FAIL: Dados inválidos.");
    }

    // 5. CLIQUE NO EXTRATO (Página 2 - Lógica Manus)
    try {
        const linkExtrato = await page.$('a[href*="extrato" i]');
        if (linkExtrato) {
            console.log("[DETRAN] Baixando Extrato Completo...");
            await linkExtrato.click();
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(2000);
        }
    } catch (e) {
        // Ignora falha na página 2 (segue com a página 1)
    }

    // 6. GERAÇÃO DO PDF (Screenshot)
    console.log("[DETRAN] Gerando PDF...");
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    
    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(screenshot);
    const pagePdf = pdfDoc.addPage([pngImage.width, pngImage.height]);
    pagePdf.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });
    
    const pdfBytes = await pdfDoc.save();

    // 7. CLASSIFICAÇÃO
    let status = "DESCONHECIDO";
    let temProblemas = false;
    let motivo = "";

    if (textoTela.includes("CONDUTOR POSSUI") && textoTela.includes("CASSAÇÃO DA CNH")) {
        status = "CASSACAO"; temProblemas = true; motivo = "Cassação da CNH";
    } else if (textoTela.includes("CONDUTOR POSSUI") && textoTela.includes("SUSPENSÃO DO DIREITO")) {
        status = "SUSPENSAO"; temProblemas = true; motivo = "Suspensão do Direito de Dirigir";
    } else if (textoTela.includes("INFRAÇÃO") && !textoTela.includes("NADA CONSTA")) {
        status = "MULTAS"; temProblemas = true; motivo = "Multas de Trânsito";
    } else if (textoTela.includes("NADA CONSTA")) {
        status = "OK"; temProblemas = false; motivo = "Nada Consta";
    }

    return {
        pdfBuffer: Buffer.from(pdfBytes),
        analise: {
            status,
            motivo,
            temProblemas,
            nome: "Motorista",
            dados: {}
        }
    };

  } catch (error) {
    console.error(`[DETRAN] ERRO: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

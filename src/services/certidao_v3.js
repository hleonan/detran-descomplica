import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

[cite_start]// URL DIRETA (Manus) [cite: 20]
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] Iniciando v3.2 (Otimizada para Timeout)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");
  
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Sem chave 2Captcha");

  let browser;
  try {
    [cite_start]// Configuração Anti-Bloqueio [cite: 11]
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // 1. ACESSO OTIMIZADO (AQUI ESTÁ A CORREÇÃO DO TIMEOUT)
    console.log(`[DETRAN] Conectando em ${CERTIDAO_URL}...`);
    
    // Mudança Crítica: 'commit' é muito mais rápido que 'domcontentloaded'
    await page.goto(CERTIDAO_URL, { waitUntil: 'commit', timeout: 60000 });
    
    // Espera explícita pelo campo de CPF (garante que carregou o que importa)
    console.log("[DETRAN] Aguardando formulário...");
    await page.waitForSelector('#CertidaoCpf', { state: 'visible', timeout: 60000 });

    [cite_start]// 2. PREENCHIMENTO [cite: 21]
    await page.fill('#CertidaoCpf', cpf.replace(/\D/g, ""));
    await page.fill('#CertidaoCnh', cnh.replace(/\D/g, ""));

    [cite_start]// 3. CAPTCHA [cite: 22]
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      console.log("[DETRAN] Resolvendo Captcha...");
      const src = await recaptchaFrame.getAttribute("src");
      const sitekey = new URLSearchParams(src.split("?")[1]).get("k");
      
      // Usa URL atual para garantir referer correto
      const currentUrl = page.url();

      const inRes = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${currentUrl}&json=1`);
      const inData = await inRes.json();
      const id = inData.request;

      let token = null;
      for (let i = 0; i < 40; i++) { // 2 minutos de tolerância para o captcha
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

    [cite_start]// 4. CONSULTAR [cite: 23]
    console.log("[DETRAN] Clicando em pesquisar...");
    await page.click('#btPesquisar');
    
    // Aguarda carregamento (Network Idle é seguro aqui porque já passou o form)
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(1000); 

    // ============================================================
    // TRAVA DE SEGURANÇA (Para evitar o Falso Positivo)
    // ============================================================
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());
    
    // Verifica erros comuns do Detran
    if (textoTela.includes("DADOS INFORMADOS INVÁLIDOS") || 
        textoTela.includes("NÃO CONFEREM") || 
        textoTela.includes("CAPTCHA INCORRETO")) {
        console.error(`[DETRAN] Erro na tela: ${textoTela.substring(0, 50)}...`);
        throw new Error("DETRAN_FAIL: O site recusou os dados.");
    }
    // ============================================================

    [cite_start]// 5. CLICAR NO EXTRATO COMPLETO (Página 2) [cite: 40-47]
    try {
        const linkExtrato = await page.$('a[href*="extrato" i]');
        if (linkExtrato) {
            console.log("[DETRAN] Clicando em Extrato Completo...");
            await linkExtrato.click();
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(2000);
        }
    } catch (e) {
        console.log("[DETRAN] Link de extrato não encontrado (provavelmente Nada Consta).");
    }

    [cite_start]// 6. GERAÇÃO DO PDF (Screenshot - Método Manus) [cite: 24]
    console.log("[DETRAN] Gerando PDF visual...");
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    
    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(screenshot);
    const pagePdf = pdfDoc.addPage([pngImage.width, pngImage.height]);
    pagePdf.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });
    
    const pdfBytes = await pdfDoc.save();

    [cite_start]// 7. CLASSIFICAÇÃO [cite: 34-39]
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
    console.error(`[DETRAN] ERRO FATAL: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

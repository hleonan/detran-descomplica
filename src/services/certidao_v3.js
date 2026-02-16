import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

// URL EXATA DO RELATÓRIO DA MANUS (Página 1, item 20)
const CERTIDAO_URL = "https://www2.detran.rj.gov.br/portal/multas/certidao";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] Iniciando automação (Padrão Manus v3.2)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");
  
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Sem chave 2Captcha");

  let browser;
  try {
    // Configuração conforme PDF da Manus (Página 1, item 11)
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

    // 1. ACESSO DIRETO (Conforme PDF Item 20)
    // Se você testou e abriu, o robô tem que abrir também.
    console.log(`[DETRAN] Acessando ${CERTIDAO_URL}...`);
    await page.goto(CERTIDAO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 2. PREENCHIMENTO (PDF Item 21)
    await page.waitForSelector('#CertidaoCpf', { state: 'visible', timeout: 30000 });
    await page.fill('#CertidaoCpf', cpf.replace(/\D/g, ""));
    await page.fill('#CertidaoCnh', cnh.replace(/\D/g, ""));

    // 3. CAPTCHA (PDF Item 22)
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

    // 4. CONSULTAR (PDF Item 23)
    console.log("[DETRAN] Clicando em pesquisar...");
    await page.click('#btPesquisar');
    
    // Aguarda carregamento da resposta
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(2000); 

    // ============================================================
    // TRAVA DE SEGURANÇA (Única alteração solicitada por você)
    // Impede o "Falso Positivo" descrito no PDF (Item 30-33)
    // ============================================================
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());
    
    if (textoTela.includes("DADOS INFORMADOS INVÁLIDOS") || 
        textoTela.includes("NÃO CONFEREM") || 
        textoTela.includes("CAPTCHA INCORRETO") ||
        textoTela.includes("ERRO NA CONSULTA")) {
        console.error(`[DETRAN] Erro na tela: ${textoTela.substring(0, 50)}...`);
        throw new Error("DETRAN_FAIL: Dados incorretos ou site instável.");
    }
    // ============================================================

    // 5. CLICAR NO EXTRATO COMPLETO (PDF Item 24 e 40-52)
    // Essa parte é CRUCIAL para pegar a Página 2 com as multas
    try {
        // Tenta estratégia 1: Seletor por href (PDF Item 46)
        const linkExtrato = await page.$('a[href*="extrato" i]');
        if (linkExtrato) {
            console.log("[DETRAN] Clicando em Extrato Completo (Página 2)...");
            await linkExtrato.click();
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(2000);
        }
    } catch (e) {
        console.log("[DETRAN] Não foi necessário clicar no extrato ou falhou.");
    }

    // 6. GERAÇÃO DO PDF (PDF Item 24 - Screenshot)
    console.log("[DETRAN] Gerando PDF (Screenshot)...");
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    
    const pdfDoc = await PDFDocument.create();
    const pngImage = await pdfDoc.embedPng(screenshot);
    const pagePdf = pdfDoc.addPage([pngImage.width, pngImage.height]);
    pagePdf.drawImage(pngImage, { x: 0, y: 0, width: pngImage.width, height: pngImage.height });
    
    const pdfBytes = await pdfDoc.save();

    // 7. CLASSIFICAÇÃO (PDF Item 34-39 - Frases Exatas)
    // Regex e lógica recuperada do relatório da Manus
    let status = "DESCONHECIDO";
    let temProblemas = false;
    let motivo = "";

    // PDF Item 38 (Cassação)
    if (textoTela.includes("CONDUTOR POSSUI") && textoTela.includes("CASSAÇÃO DA CNH")) {
        status = "CASSACAO"; temProblemas = true; motivo = "Cassação da CNH";
    } 
    // PDF Item 37 (Suspensão)
    else if (textoTela.includes("CONDUTOR POSSUI") && textoTela.includes("SUSPENSÃO DO DIREITO")) {
        status = "SUSPENSAO"; temProblemas = true; motivo = "Suspensão do Direito de Dirigir";
    } 
    // PDF Item 36 (Multas)
    else if (textoTela.includes("INFRAÇÃO") && !textoTela.includes("NADA CONSTA")) {
        status = "MULTAS"; temProblemas = true; motivo = "Multas de Trânsito";
    } 
    // PDF Item 35 (Nada Consta)
    else if (textoTela.includes("NADA CONSTA")) {
        status = "OK"; temProblemas = false; motivo = "Nada Consta";
    }

    // Retorno do objeto (PDF Item 103-112)
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

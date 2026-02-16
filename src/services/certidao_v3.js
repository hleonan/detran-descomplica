import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

// LINKS DO DETRAN
const URL_DIRETA = "https://www2.detran.rj.gov.br/portal/multas/certidao";
const URL_MENU = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.log("[DETRAN] Iniciando automação (Modo Híbrido: Direto + Fallback)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");
  
  const cpfLimpo = cpf.replace(/\D/g, "");
  const cnhLimpo = cnh.replace(/\D/g, "");
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Sem chave 2Captcha");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // ============================================================
    // 1. NAVEGAÇÃO INTELIGENTE (Tenta Direto -> Falha -> Tenta Menu)
    // ============================================================
    let acessou = false;

    // TENTATIVA 1: URL DIRETA (Rápida)
    try {
        console.log(`[DETRAN] Tentando acesso rápido (${URL_DIRETA})...`);
        await page.goto(URL_DIRETA, { waitUntil: 'domcontentloaded', timeout: 15000 }); // 15s de tolerância
        await page.waitForSelector('#CertidaoCpf', { timeout: 5000 }); // Verifica se carregou o form
        acessou = true;
        console.log("[DETRAN] Acesso rápido funcionou!");
    } catch (e) {
        console.warn("[DETRAN] Acesso rápido falhou ou bloqueado. Tentando via Menu...");
    }

    // TENTATIVA 2: VIA MENU (Se a direta falhou)
    if (!acessou) {
        try {
            console.log(`[DETRAN] Acessando via Menu (${URL_MENU})...`);
            await page.goto(URL_MENU, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // Procura o link "Nada Consta" e clica
            const clicou = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const target = links.find(a => a.href.includes('nada-consta.html'));
                if (target) { target.click(); return true; }
                return false;
            });

            if (!clicou) {
                // Força a navegação se não achar o link
                await page.goto("https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html", { waitUntil: 'domcontentloaded' });
            }
            
            await page.waitForSelector('#CertidaoCpf', { state: 'visible', timeout: 30000 });
            console.log("[DETRAN] Acesso via Menu funcionou!");
        } catch (e) {
            throw new Error("DETRAN_FAIL: Site do DETRAN inacessível (Timeout). Tente mais tarde.");
        }
    }

    // 2. PREENCHIMENTO
    console.log("[DETRAN] Preenchendo formulário...");
    await page.fill('#CertidaoCpf', cpfLimpo);
    await page.fill('#CertidaoCnh', cnhLimpo);

    // 3. CAPTCHA
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      console.log("[DETRAN] Resolvendo Captcha...");
      const src = await recaptchaFrame.getAttribute("src");
      const sitekey = new URLSearchParams(src.split("?")[1]).get("k");
      
      // Usa a URL atual da página para o captcha (importante pois pode ter mudado)
      const currentUrl = page.url(); 

      const inRes = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${currentUrl}&json=1`);
      const inData = await inRes.json();
      const id = inData.request;

      let token = null;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(3000);
        const res = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${id}&json=1`);
        const data = await res.json();
        if (data.status === 1) { token = data.request; break; }
      }

      if (!token) throw new Error("Captcha Timeout - O serviço demorou muito.");

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
    console.log("[DETRAN] Enviando consulta...");
    await page.click('#btPesquisar');
    await page.waitForLoadState('networkidle', { timeout: 45000 });
    await page.waitForTimeout(1500); 

    // === VALIDAÇÃO DE ERRO (PROTEÇÃO WHATSAPP) ===
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());
    if (textoTela.includes("DADOS INFORMADOS INVÁLIDOS") || 
        textoTela.includes("NÃO CONFEREM") || 
        textoTela.includes("ERRO NA CONSULTA")) {
        console.error(`[DETRAN] Erro na tela: ${textoTela.substring(0, 50)}...`);
        throw new Error("DETRAN_FAIL: O site recusou os dados. Verifique CPF/CNH.");
    }

    // 5. CLIQUE NO EXTRATO COMPLETO (Página 2 - Lógica da Manus)
    try {
        const linkExtrato = await page.$('a[href*="extrato" i]');
        if (linkExtrato) {
            console.log("[DETRAN] Baixando Extrato Completo (Página 2)...");
            await linkExtrato.click();
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(2000);
        }
    } catch (e) {
        console.log("[DETRAN] Sem página 2 ou falha ao clicar.");
    }

    // 6. GERAÇÃO DO PDF (Visual Exato via Screenshot)
    console.log("[DETRAN] Gerando PDF final...");
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

    if (textoTela.includes("CASSAÇÃO DA CNH") && textoTela.includes("POSSUI")) {
        status = "CASSACAO"; temProblemas = true; motivo = "Cassação da CNH";
    } else if (textoTela.includes("SUSPENSÃO DO DIREITO") && textoTela.includes("POSSUI")) {
        status = "SUSPENSAO"; temProblemas = true; motivo = "Suspensão do Direito de Dirigir";
    } else if (textoTela.includes("INFRAÇÃO") && !textoTela.includes("NADA CONSTA")) {
        status = "MULTAS"; temProblemas = true; motivo = "Multas de Trânsito";
    } else if (textoTela.includes("NADA CONSTA")) {
        status = "OK"; temProblemas = false; motivo = "Nada Consta";
    }

    return {
        pdfBuffer: Buffer.from(pdfBytes),
        analise: { status, motivo, temProblemas, nome: "Motorista", dados: {} }
    };

  } catch (error) {
    console.error(`[DETRAN] ERRO: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

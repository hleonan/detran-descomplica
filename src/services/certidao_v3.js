import { chromium } from "playwright";

// URLs mapeadas
const MENU_URL = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] Iniciando consulta rigorosa...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  // Remove formatação para evitar erros bobos
  const cpfFormatted = cpf.replace(/\D/g, "");
  const cnhFormatted = cnh.replace(/\D/g, "");
  
  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("Configuração de API inválida (Captcha).");

  let browser;
  let page;

  try {
    // 1. CONFIGURAÇÃO DO NAVEGADOR (Modo Furtivo)
    browser = await chromium.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-blink-features=AutomationControlled', // Esconde que é robô
            '--window-size=1366,768',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ] 
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true
    });

    page = await context.newPage();

    // 2. NAVEGAÇÃO SEGURA (Via Menu)
    try {
        await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 40000 });
    } catch (e) {
        // Se o menu falhar, tenta direto (fallback)
        console.error("Menu falhou, tentando direto...");
        await page.goto("https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html", { waitUntil: "domcontentloaded" });
    }

    // Tenta clicar no link do Nada Consta
    const linkClicado = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const target = links.find(a => a.href.includes('nada-consta.html'));
        if (target) { target.click(); return true; }
        return false;
    });

    if (!linkClicado && page.url() === MENU_URL) {
        // Força navegação se o clique não funcionou
        await page.goto("https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html");
    }

    // 3. PREENCHIMENTO (Com validação visual)
    await page.waitForSelector("#CertidaoCpf", { state: 'visible', timeout: 30000 });
    
    // Limpa e digita com delay para o JS do site captar
    await page.fill("#CertidaoCpf", "");
    await page.type("#CertidaoCpf", cpfFormatted, { delay: 150 });
    
    await page.fill("#CertidaoCnh", "");
    await page.type("#CertidaoCnh", cnhFormatted, { delay: 150 });

    // 4. QUEBRA DO CAPTCHA (2Captcha)
    const frameElement = await page.$('iframe[src*="recaptcha/api2/anchor"]');
    if (frameElement) {
        console.error("[DETRAN] Resolvendo Captcha...");
        const src = await frameElement.getAttribute("src");
        const urlParams = new URLSearchParams(src.split("?")[1]);
        const sitekey = urlParams.get("k");

        if (sitekey) {
            const inResp = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${page.url()}&json=1`);
            const inData = await inResp.json();
            
            if (inData.status === 1) {
                const idRequest = inData.request;
                let token = null;
                
                // Espera até 90s (Detran as vezes é lento)
                for (let i = 0; i < 30; i++) {
                    await page.waitForTimeout(3000);
                    const resResp = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${idRequest}&json=1`);
                    const resData = await resResp.json();
                    if (resData.status === 1) {
                        token = resData.request;
                        break;
                    }
                }

                if (token) {
                    await page.evaluate((t) => {
                        document.getElementById("g-recaptcha-response").innerHTML = t;
                        document.getElementById("g-recaptcha-response").value = t;
                        if(window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                            Object.values(window.___grecaptcha_cfg.clients).forEach(c => {
                                Object.values(c).forEach(k => k.callback && k.callback(t));
                            });
                        }
                    }, token);
                } else {
                    throw new Error("O serviço de Captcha demorou muito. Tente novamente.");
                }
            }
        }
    }

    // 5. ENVIAR CONSULTA
    console.error("[DETRAN] Enviando dados...");
    await page.click("#btPesquisar");
    
    // Aguarda a resposta (navegação ou erro na mesma tela)
    await page.waitForLoadState('networkidle', { timeout: 40000 });
    await page.waitForTimeout(2000); // Respiro

    // 6. VALIDAÇÃO RIGOROSA DE ERRO (AQUI ESTÁ A CORREÇÃO)
    // Lê o texto da tela para ver se deu ruim
    const textoTela = await page.evaluate(() => document.body.innerText.toUpperCase());

    const errosCriticos = [
        "DADOS INFORMADOS INVÁLIDOS",
        "DADOS NÃO CONFEREM",
        "ERRO NA CONSULTA",
        "TENTE NOVAMENTE",
        "SERVIÇO INDISPONÍVEL",
        "CAPTCHA INCORRETO",
        "NENHUM REGISTRO ENCONTRADO",
        "PARÂMETROS INVÁLIDOS"
    ];

    for (const erro of errosCriticos) {
        if (textoTela.includes(erro)) {
            console.error(`[DETRAN] Falha detectada: ${erro}`);
            // LANÇA ERRO PARA O FRONTEND (NÃO GERA PDF!)
            throw new Error("DETRAN_FAIL: O site do DETRAN retornou erro. Verifique os dados ou tente mais tarde.");
        }
    }

    // Verifica se parece uma certidão de verdade
    if (!textoTela.includes("CERTIDÃO") && !textoTela.includes("NADA CONSTA") && !textoTela.includes("OCORRÊNCIA")) {
        console.error("[DETRAN] Tela desconhecida. Abortando para segurança.");
        throw new Error("DETRAN_FAIL: O site do DETRAN não retornou uma certidão válida.");
    }

    // 7. SUCESSO REAL - GERA PDF
    console.error("[DETRAN] Sucesso confirmado. Gerando PDF...");
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    
    return pdfBuffer;

  } catch (error) {
    console.error(`[DETRAN] ERRO FINAL: ${error.message}`);
    throw error; // Repassa o erro para o API.js tratar
  } finally {
    if (browser) await browser.close();
  }
}

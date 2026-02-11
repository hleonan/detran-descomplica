import { chromium } from "playwright";
import fs from "fs";

// URLs mapeadas
const MENU_URL = "https://www.detran.rj.gov.br/menu/menu-infracoes.html";

export async function emitirCertidaoPDF(cpf, cnh) {
  console.error("[DETRAN] Iniciando fluxo de emissão (Stealth + Validação de Erro)...");

  if (!cpf || !cnh) throw new Error("CPF e CNH são obrigatórios");

  const cpfFormatted = cpf.replace(/\D/g, "");
  const cnhFormatted = cnh.replace(/\D/g, "");

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (!twocaptchaKey) throw new Error("TWOCAPTCHA_API_KEY não configurada");

  let browser;
  let page;

  try {
    // 1. CONFIGURAÇÃO ANTI-BOT
    console.error("[DETRAN] Iniciando navegador...");
    browser = await chromium.launch({ 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,768',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ] 
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        ignoreHTTPSErrors: true
    });

    page = await context.newPage();
    
    // Headers extras
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.detran.rj.gov.br/' 
    });

    // 2. NAVEGAÇÃO
    console.error(`[DETRAN] Acessando menu...`);
    await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    console.error("[DETRAN] Buscando serviço...");
    const linkClicado = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const target = links.find(a => a.href.includes('nada-consta.html'));
        if (target) { target.click(); return true; }
        return false;
    });

    if (!linkClicado) {
        await page.goto("https://www.detran.rj.gov.br/infracoes/principais-servicos-infracoes/nada-consta.html", {
            referer: MENU_URL
        });
    }

    // 3. PREENCHIMENTO
    console.error("[DETRAN] Preenchendo dados...");
    await page.waitForSelector("#CertidaoCpf", { state: 'visible', timeout: 30000 });
    
    await page.type("#CertidaoCpf", cpfFormatted, { delay: 100 });
    await page.type("#CertidaoCnh", cnhFormatted, { delay: 100 });

    // 4. CAPTCHA
    console.error("[DETRAN] Resolvendo Captcha...");
    const frameElement = await page.$('iframe[src*="recaptcha/api2/anchor"]');
    if (frameElement) {
        const src = await frameElement.getAttribute("src");
        const urlParams = new URLSearchParams(src.split("?")[1]);
        const sitekey = urlParams.get("k");

        if (!sitekey) throw new Error("Sitekey do Captcha não encontrada.");

        const inResp = await fetch(`http://2captcha.com/in.php?key=${twocaptchaKey}&method=userrecaptcha&googlekey=${sitekey}&pageurl=${page.url()}&json=1`);
        const inData = await inResp.json();
        if (inData.status !== 1) throw new Error("Erro 2Captcha: " + inData.request);

        const idRequest = inData.request;
        console.error(`[DETRAN] Captcha ID: ${idRequest}. Aguardando...`);

        let token = null;
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(3000);
            const resResp = await fetch(`http://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${idRequest}&json=1`);
            const resData = await resResp.json();
            if (resData.status === 1) {
                token = resData.request;
                break;
            }
        }

        if (!token) throw new Error("Timeout no Captcha.");

        await page.evaluate((t) => {
            document.getElementById("g-recaptcha-response").innerHTML = t;
            document.getElementById("g-recaptcha-response").value = t;
            if(window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                Object.values(window.___grecaptcha_cfg.clients).forEach(c => {
                    Object.values(c).forEach(k => k.callback && k.callback(t));
                });
            }
        }, token);
    }

    // 5. CONSULTAR
    console.error("[DETRAN] Clicando em Consultar...");
    await page.evaluate(() => document.getElementById("btPesquisar").click());

    console.error("[DETRAN] Aguardando resposta do servidor...");
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    // === AQUI ESTÁ A CORREÇÃO (TRAVA DE SEGURANÇA) ===
    console.error("[DETRAN] Analisando o texto da tela...");

    // Lê todo o texto visível na página
    const textoTela = await page.evaluate(() => document.body.innerText);

    // Lista de frases que indicam ERRO no Detran RJ
    const frasesDeErro = [
        "DADOS INFORMADOS INVÁLIDOS",
        "DADOS NÃO CONFEREM",
        "ERRO NA CONSULTA",
        "TENTE NOVAMENTE MAIS TARDE",
        "SERVIÇO INDISPONÍVEL",
        "CAPTCHA INCORRETO",
        "NENHUM REGISTRO ENCONTRADO" // Às vezes aparece quando dados estão errados
    ];

    // Se encontrar qualquer erro, PARA TUDO e lança erro (não gera PDF)
    for (const frase of frasesDeErro) {
        if (textoTela.toUpperCase().includes(frase)) {
            console.error(`[DETRAN] Erro detectado na tela: ${frase}`);
            throw new Error(`O DETRAN recusou a consulta: ${frase}. Verifique se o CPF e a CNH estão corretos.`);
        }
    }

    // Verifica se realmente carregou uma certidão (Sucesso)
    const carregouCertidao = textoTela.includes("CERTIDÃO") || 
                             textoTela.includes("NADA CONSTA") || 
                             textoTela.includes("OCORRÊNCIA");

    if (!carregouCertidao) {
        // Se não tem erro explícito, mas também não tem certidão, é suspeito.
        // Vamos tirar um print de debug antes de falhar
        await page.screenshot({ path: '/tmp/debug_tela_estranha.png' });
        console.warn("[DETRAN] Tela final não parece uma certidão. Verifique /tmp/debug_tela_estranha.png");
        // Opcional: throw new Error("A página carregou mas não mostrou a certidão.");
    }

    // 6. GERAR PDF (Só chega aqui se passou pelo teste de erro)
    console.error("[DETRAN] Tela validada. Gerando PDF...");
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    
    return pdfBuffer;

  } catch (error) {
    console.error(`[DETRAN] ERRO FINAL: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

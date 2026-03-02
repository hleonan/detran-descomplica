import { chromium } from 'playwright';
import TwoCaptcha from './services/TwoCaptchaClass.js';

/**
 * Automação para consultar pontuação/multas no DETRAN-RJ
 * URL: http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao
 */

class PontuacaoAutomation {
  constructor(apiKey2Captcha) {
    this.twoCaptcha = new TwoCaptcha(apiKey2Captcha);
    this.browser = null;
    this.cpf = '';
    this.cnh = '';
    this.consultaUrl = 'https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao';
  }

  async consultarPontuacao(cpf, cnh, uf = 'RJ') {
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });

      const context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        ignoreHTTPSErrors: true
      });

      const page = await context.newPage();

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await this.abrirPaginaConsulta(page);

      this.cpf = String(cpf || '');
      this.cnh = String(cnh || '');

      await page.fill('input[name="cpf"]', this.cpf);
      await page.fill('input[name="cnh"]', this.cnh);
      await page.selectOption('select[name="uf"]', uf || 'RJ');

      const resultado = await this.enviarConsultaComRetryCaptcha(page);

      await context.close();
      await this.browser.close();

      return resultado;
    } catch (error) {
      if (this.browser) {
        try { await this.browser.close(); } catch (e) {}
      }
      throw error;
    }
  }

  async enviarConsultaComRetryCaptcha(page) {
    let ultimaErro = null;

    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
      try {
        await this.prepararFormularioConsulta(page);

        console.log(`[MULTAS] Resolvendo CAPTCHA (tentativa ${tentativa}/2)...`);
        const captchaToken = await this.resolverCaptcha(page);
        if (!captchaToken) throw new Error('Falha ao resolver CAPTCHA (token não retornado pelo serviço).');

        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
          page.click('button[type="submit"]')
        ]);

        const resultado = await this.capturarResultado(page);
        if (resultado.sucesso) return resultado;

        if (!this.ehErroCaptcha(resultado.erro) || tentativa === 2) {
          return resultado;
        }

        ultimaErro = resultado.erro;
        console.warn('[MULTAS] CAPTCHA rejeitado pelo DETRAN, nova tentativa...');
      } catch (err) {
        ultimaErro = err?.message || String(err);
        if (/DETRAN_MULTAS_OFFLINE/i.test(ultimaErro) || tentativa === 2) throw err;
      }

      await this.abrirPaginaConsulta(page);
    }

    throw new Error(ultimaErro || 'Falha ao consultar multas.');
  }

  async abrirPaginaConsulta(page) {
    const tentativasDiretas = [
      'https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao',
      'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao'
    ];
    const errosDiretos = [];

    const estaNaTelaConsulta = async () => {
      const urlAtual = page.url() || '';
      if (!/consultaPontuacao/i.test(urlAtual)) return false;
      return (await page.locator('input[name="cpf"]').count()) > 0;
    };

    const mensagemErro = (err) => String(err?.message || err || '');
    const ehErroConexaoPortalMultas = (msg = '') =>
      /(ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED)/i.test(msg);
    const ehInterrupcaoNavegacao = (msg = '') =>
      /is interrupted by another navigation|navigation interrupted/i.test(msg);

    const confirmarPortalOffline = async () => {
      const urls = [
        'https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao',
        'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao'
      ];

      for (const url of urls) {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 8000);
          const resp = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            signal: ac.signal,
          });
          clearTimeout(timer);

          // Qualquer resposta HTTP indica conectividade com o portal.
          if (resp && typeof resp.status === 'number') return false;
        } catch (err) {
          const msg = mensagemErro(err);
          if (!ehErroConexaoPortalMultas(msg) && !/abort|timed out|fetch failed/i.test(msg)) {
            return false;
          }
        }
      }

      return true;
    };

    const talvezLancarOffline = async (mensagemOriginal = '') => {
      const confirmado = await confirmarPortalOffline();
      if (confirmado) {
        throw new Error('DETRAN_MULTAS_OFFLINE: portal de multas do DETRAN-RJ indisponivel no momento.');
      }
      throw new Error(`Falha ao acessar o portal de multas do DETRAN-RJ. ${mensagemOriginal}`.trim());
    };

    for (const url of tentativasDiretas) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('input[name="cpf"]', { timeout: 12000 });
        this.consultaUrl = page.url();
        return;
      } catch (err) {
        const msg = mensagemErro(err);

        if (ehInterrupcaoNavegacao(msg)) {
          await page.waitForTimeout(1200);
          if (await estaNaTelaConsulta()) {
            this.consultaUrl = page.url();
            return;
          }
        }

        if (await estaNaTelaConsulta()) {
          this.consultaUrl = page.url();
          return;
        }
        errosDiretos.push(msg);
        console.warn(`[MULTAS] Falha ao abrir URL direta ${url}:`, msg);
      }
    }

    // Fallback: navegação pelo site principal (card Infrações -> Consulta de Pontuação na CNH)
    try {
      await page.goto('https://www.detran.rj.gov.br/menu/menu-infracoes.html', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
    } catch (err) {
      // O portal pode redirecionar automaticamente para consultaPontuacao e interromper este goto.
      await page.waitForTimeout(1200);
      if (await estaNaTelaConsulta()) {
        this.consultaUrl = page.url();
        return;
      }

      const msg = mensagemErro(err);
      if (ehInterrupcaoNavegacao(msg)) {
        try {
          await page.goto('https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await page.waitForSelector('input[name="cpf"]', { timeout: 10000 });
          this.consultaUrl = page.url();
          return;
        } catch (err2) {
          const msg2 = mensagemErro(err2);
          errosDiretos.push(msg2);
          if (await estaNaTelaConsulta()) {
            this.consultaUrl = page.url();
            return;
          }
        }
      }

      if (ehErroConexaoPortalMultas(msg) || errosDiretos.some(ehErroConexaoPortalMultas)) {
        await talvezLancarOffline(msg);
      }
      throw err;
    }

    if (await estaNaTelaConsulta()) {
      this.consultaUrl = page.url();
      return;
    }

    const linkConsulta = page.locator('a[href*="consultaPontuacao"], li:has-text("Consulta de Pontuação na CNH") a').first();
    if (!(await linkConsulta.count())) {
      if (errosDiretos.some(ehErroConexaoPortalMultas)) {
        await talvezLancarOffline('Nao foi possivel localizar o link de consulta no portal.');
      }
      throw new Error('Não foi possível localizar o link de Consulta de Pontuação na CNH no site do DETRAN.');
    }

    try {
      await Promise.all([
        page.waitForURL(/consultaPontuacao/i, { timeout: 30000 }),
        linkConsulta.click({ timeout: 8000 })
      ]);
    } catch (err) {
      await page.waitForTimeout(1200);
      if (await estaNaTelaConsulta()) {
        this.consultaUrl = page.url();
        return;
      }

      const msg = mensagemErro(err);
      if (ehErroConexaoPortalMultas(msg) || errosDiretos.some(ehErroConexaoPortalMultas)) {
        await talvezLancarOffline(msg);
      }
      throw err;
    }

    await page.waitForSelector('input[name="cpf"]', { timeout: 12000 });
    this.consultaUrl = page.url();
  }

  async prepararFormularioConsulta(page) {
    await page.waitForSelector('input[name="cpf"]', { timeout: 15000 });
    await page.fill('input[name="cpf"]', this.cpf);
    await page.fill('input[name="cnh"]', this.cnh);
    await page.selectOption('select[name="uf"]', 'RJ');
  }

  ehErroCaptcha(mensagem = '') {
    return /captcha|recaptcha|não sou robô|nao sou robo|token/i.test(String(mensagem || ''));
  }

  async resolverCaptcha(page) {
    try {
      const captchaElement = await page.$('iframe[src*="recaptcha"]');
      
      if (!captchaElement) {
        const imagemCaptcha = await page.$('img[alt*="captcha"]');
        if (imagemCaptcha) {
          const screenshot = await imagemCaptcha.screenshot();
          const captchaId = await this.twoCaptcha.uploadCaptcha(screenshot);
          return this.twoCaptcha.obterResultado(captchaId);
        }
        return null;
      }

      const captchaInfo = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="recaptcha"]');
        const src = iframe?.src || '';
        const fromIframe = src.match(/[?&]k=([^&]+)/)?.[1] || null;

        const widget = document.querySelector('.g-recaptcha, [data-sitekey]');
        const fromDataSitekey = widget?.getAttribute('data-sitekey') || null;
        const callbackName = widget?.getAttribute('data-callback') || null;
        const enterprise = /enterprise/i.test(src) || !!document.querySelector('script[src*="recaptcha/enterprise"]');
        const invisible = widget?.getAttribute('data-size') === 'invisible';

        return {
          sitekey: fromDataSitekey || fromIframe,
          callbackName,
          enterprise,
          invisible
        };
      });

      if (!captchaInfo?.sitekey) {
        throw new Error('Não foi possível extrair o sitekey do reCAPTCHA');
      }

      const captchaId = await this.twoCaptcha.uploadReCaptcha(
        captchaInfo.sitekey,
        this.consultaUrl || page.url() || 'https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao',
        {
          enterprise: captchaInfo.enterprise,
          invisible: captchaInfo.invisible,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        }
      );

      const token = await this.twoCaptcha.obterResultado(captchaId);
      
      await page.evaluate(({ resolvedToken, callbackName }) => {
        const responseFields = document.querySelectorAll('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
        responseFields.forEach((field) => {
          field.innerHTML = resolvedToken;
          field.value = resolvedToken;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        });

        if (callbackName && typeof window[callbackName] === 'function') {
          window[callbackName](resolvedToken);
        }
      }, { resolvedToken: token, callbackName: captchaInfo.callbackName });

      await page.waitForTimeout(300);
      return token;
    } catch (error) {
      console.error('Erro ao resolver CAPTCHA:', error);
      return null;
    }
  }

  async capturarResultado(page) {
    try {
      await page.waitForSelector('body', { timeout: 10000 });

      const erroTela = await page.evaluate(() => {
        const texto = document.body.innerText || '';
        const padraoErro = /(não foi possível|captcha inválido|dados inválidos|erro ao consultar)/i;
        return padraoErro.test(texto) ? texto.slice(0, 350) : null;
      });
      if (erroTela) {
        return { sucesso: false, erro: `DETRAN retornou erro na consulta de pontuação. ${erroTela}` };
      }

      const resumo = await this.extrairResumoPontuacao(page);

      await this.abrirDetalhesTodasInfracoes(page);

      const multas = await this.extrairMultasDetalhadas(page);

      return {
        sucesso: true,
        multas,
        resumo,
        dataConsulta: new Date().toISOString()
      };
    } catch (error) {
      console.error('Erro ao capturar resultado:', error);
      return {
        sucesso: false,
        erro: error.message
      };
    }
  }

  async extrairResumoPontuacao(page) {
    return page.evaluate(() => {
      const textoNormalizado = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const numero = (s) => {
        const m = String(s || '').match(/\d+/);
        return m ? m[0] : '0';
      };

      const resumo = {
        pontosTotais: '0',
        multasPendentes: '0',
        situacao: 'Regular'
      };

      const linhas = Array.from(document.querySelectorAll('tr'));
      let quantidadeAutosUltimos5Anos = 0;
      let pontosUltimos5Anos = 0;

      for (const tr of linhas) {
        const tds = Array.from(tr.querySelectorAll('td')).map((td) => textoNormalizado(td.textContent));
        if (tds.length < 3) continue;

        const titulo = tds[0].toLowerCase();
        if (titulo.includes('infrações pontuáveis') && titulo.includes('últimos 5 anos')) {
          quantidadeAutosUltimos5Anos = Number(numero(tds[1]));
          pontosUltimos5Anos = Number(numero(tds[2]));
        }
      }

      resumo.pontosTotais = String(pontosUltimos5Anos || 0);
      resumo.multasPendentes = String(quantidadeAutosUltimos5Anos || 0);

      if (pontosUltimos5Anos > 0 || quantidadeAutosUltimos5Anos > 0) {
        resumo.situacao = 'Com infrações';
      }

      return resumo;
    });
  }

  async abrirDetalhesTodasInfracoes(page) {
    // Tenta clicar no ícone de lupa da linha "Todas as Infrações (últimos 5 anos)".
    const lupa = page.locator('tr', { hasText: 'Todas as Infrações (últimos 5 anos)' }).locator('a, img').first();

    if (await lupa.count()) {
      const currentUrl = page.url();
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 15000 }),
          lupa.click({ timeout: 5000 })
        ]);
      } catch {
        // fallback: clique sem wait explícito
        try { await lupa.click({ timeout: 3000 }); } catch (e) {}
      }

      await page.waitForTimeout(1200);
      if (page.url() === currentUrl) {
        // Algumas páginas abrem detalhe em popup/mesma tela sem alterar URL;
        // segue para extração mesmo assim.
      }
    }
  }

  async extrairMultasDetalhadas(page) {
    await page.waitForTimeout(800);

    // Se houver links "Nº Auto", clica em todos para expandir detalhamento.
    const linksNumeroAuto = page.locator('a', { hasText: 'Nº Auto' });
    const totalLinks = await linksNumeroAuto.count();
    for (let i = 0; i < totalLinks; i += 1) {
      try {
        await linksNumeroAuto.nth(i).click({ timeout: 2000 });
        await page.waitForTimeout(250);
      } catch (e) {}
    }

    const multas = await page.evaluate(() => {
      const texto = (document.body?.innerText || '').replace(/\u00A0/g, ' ');
      const blocos = texto
        .split(/(?=N[ºo]\s*Auto\s*:)/i)
        .map((b) => b.trim())
        .filter((b) => /N[ºo]\s*Auto\s*:/i.test(b));

      const parseCampo = (bloco, regex) => {
        const m = bloco.match(regex);
        return m?.[1]?.trim() || '';
      };

      const dados = blocos.map((bloco) => {
        const auto = parseCampo(bloco, /N[ºo]\s*Auto\s*:\s*([^\n]+)/i);
        const dataHora = parseCampo(bloco, /Data\s*:\s*([^\n]+)/i);
        const orgao = parseCampo(bloco, /Org[aã]o\s*:\s*([^\n]+)/i);
        const placa = parseCampo(bloco, /Placa\s*:\s*([^\n]+)/i);
        const proprietario = parseCampo(bloco, /Propriet[aá]rio\s*:\s*([^\n]+)/i);
        const responsavel = parseCampo(bloco, /Resp\.\s*Pontos\s*:\s*([^\n]+)/i);

        const descricao = [
          auto ? `Auto ${auto}` : '',
          orgao ? `Órgão: ${orgao}` : '',
          placa ? `Placa: ${placa}` : '',
          proprietario ? `Proprietário: ${proprietario}` : '',
          responsavel ? `Resp. Pontos: ${responsavel}` : ''
        ].filter(Boolean).join(' • ');

        return {
          data: dataHora || '-',
          descricao: descricao || bloco.slice(0, 200),
          pontos: '-',
          valor: '-',
          status: 'Pendente',
          numeroAuto: auto || null,
          orgao: orgao || null,
          placa: placa || null,
          proprietario: proprietario || null,
          responsavelPontos: responsavel || null
        };
      });

      // fallback para layout tabular
      if (!dados.length) {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows
          .map((row) => {
            const cells = Array.from(row.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
            if (!cells.length) return null;
            return {
              data: cells[0] || '-',
              descricao: cells[1] || 'Infração de trânsito',
              pontos: cells[2] || '-',
              valor: cells[3] || '-',
              status: cells[4] || 'Pendente'
            };
          })
          .filter(Boolean);
      }

      return dados;
    });

    return multas;
  }
}

export default PontuacaoAutomation;

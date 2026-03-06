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
    this.consultaUrl = 'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao';
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

        const botaoConsultar = page
          .locator('button[type="submit"], input[type="submit"], button:has-text("Consultar"), input[value*="Consultar" i]')
          .first();

        await botaoConsultar.waitFor({ state: 'visible', timeout: 10000 });

        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
          botaoConsultar.click()
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
      'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao',
      'https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao'
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
        'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao',
        'https://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao'
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
        for (const url of tentativasDiretas) {
          try {
            await page.goto(url, {
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
      const totalResumo = Number(String(resumo?.multasPendentes || '0').replace(/\D/g, '')) || 0;

      const paginaDetalhes = await this.abrirDetalhesTodasInfracoes(page);
      if (!paginaDetalhes && totalResumo > 0) {
        return {
          sucesso: false,
          erro: 'DETRAN_MULTAS_DETALHE_NAO_ABERTO: nao foi possivel abrir o detalhamento (lupa) para extrair as infracoes.'
        };
      }

      const multas = await this.extrairMultasDetalhadas(paginaDetalhes || page);
      if (totalResumo > 0 && (!Array.isArray(multas) || multas.length === 0)) {
        return {
          sucesso: false,
          erro: 'DETRAN_MULTAS_DETALHE_VAZIO: o DETRAN indicou multas no resumo, mas o detalhamento veio vazio.'
        };
      }

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
      let quantidadeTodasInfracoes5Anos = 0;
      let pontosUltimos5Anos = 0;

      for (const tr of linhas) {
        const tds = Array.from(tr.querySelectorAll('td')).map((td) => textoNormalizado(td.textContent));
        if (tds.length < 3) continue;

        const titulo = tds[0].toLowerCase();
        if (titulo.includes('infrações pontuáveis') && titulo.includes('últimos 5 anos')) {
          quantidadeAutosUltimos5Anos = Number(numero(tds[1]));
          pontosUltimos5Anos = Number(numero(tds[2]));
        }
        if (titulo.includes('todas as infrações') && titulo.includes('últimos 5 anos')) {
          quantidadeTodasInfracoes5Anos = Number(numero(tds[1]));
        }
      }

      resumo.pontosTotais = String(pontosUltimos5Anos || 0);
      resumo.multasPendentes = String(Math.max(quantidadeAutosUltimos5Anos || 0, quantidadeTodasInfracoes5Anos || 0));

      if (pontosUltimos5Anos > 0 || quantidadeAutosUltimos5Anos > 0 || quantidadeTodasInfracoes5Anos > 0) {
        resumo.situacao = 'Com infrações';
      }

      return resumo;
    });
  }

  async abrirDetalhesTodasInfracoes(page) {
    const context = page.context();

    const ehPagina5Anos = async (pagina) => {
      try {
        return await pagina.evaluate(() => {
          const texto = (document.body?.innerText || '').replace(/\s+/g, ' ').toUpperCase();
          return texto.includes('CONSULTA TODAS AS INFRAÇÕES (ÚLTIMOS 5 ANOS)') || /\/busca\/5anos/i.test(location.href);
        });
      } catch {
        return /\/busca\/5anos/i.test(pagina?.url?.() || '');
      }
    };

    const esperar5Anos = async (pagina, timeoutMs = 12000) => {
      try {
        await pagina.waitForFunction(() => {
          const texto = (document.body?.innerText || '').replace(/\s+/g, ' ').toUpperCase();
          return texto.includes('CONSULTA TODAS AS INFRAÇÕES (ÚLTIMOS 5 ANOS)') || /\/busca\/5anos/i.test(location.href);
        }, { timeout: timeoutMs });
        return true;
      } catch {
        return ehPagina5Anos(pagina);
      }
    };

    const clicarEObterPagina5Anos = async (locator) => {
      if (!(await locator.count())) return null;

      let popup = null;
      const popupPromise = context.waitForEvent('page', { timeout: 7000 }).catch(() => null);

      try {
        await locator.click({ timeout: 5000 });
      } catch {
        return null;
      }

      popup = await popupPromise;

      if (popup) {
        try {
          await popup.waitForLoadState('domcontentloaded', { timeout: 15000 });
          await popup.bringToFront();
        } catch (e) {}
        if (await esperar5Anos(popup, 9000)) return popup;
      }

      if (await esperar5Anos(page, 9000)) return page;
      return null;
    };

    if (await ehPagina5Anos(page)) return page;

    // 1) Seletor exato informado pelo usuário/devtools.
    let pagina5Anos = await clicarEObterPagina5Anos(page.locator('#linkConsulta5anos').first());
    if (pagina5Anos) return pagina5Anos;

    // 2) Lupa da linha "Todas as Infrações (últimos 5 anos)" na tabela de resumo.
    pagina5Anos = await clicarEObterPagina5Anos(
      page
        .locator('tr', { hasText: /Todas as Infra[cç][oõ]es\s*\(.*5 anos\)/i })
        .locator('a:has(img[src*="lupa"]), a[id*="Consulta5anos"], img.pointer')
        .first()
    );
    if (pagina5Anos) return pagina5Anos;

    // 3) Fallback por URL direta mantendo host/sessão atual.
    try {
      const urlAtual = new URL(page.url());
      const urlBusca5Anos = `${urlAtual.protocol}//${urlAtual.host}/gaideweb2/consultaPontuacao/busca/5anos`;
      await page.goto(urlBusca5Anos, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (await esperar5Anos(page, 9000)) return page;
    } catch (e) {}

    return null;
  }

  async extrairMultasDetalhadas(page) {
    await page.waitForTimeout(800);

    // Se por instabilidade ainda estiver no resumo, força mais uma tentativa.
    const aindaNoResumo = await page.evaluate(() => {
      const texto = (document.body?.innerText || '').replace(/\s+/g, ' ').toUpperCase();
      return (
        texto.includes('CONSULTA TODAS AS INFRAÇÕES') &&
        !texto.includes('CONSULTA TODAS AS INFRAÇÕES (ÚLTIMOS 5 ANOS)')
      );
    }).catch(() => false);
    if (aindaNoResumo) {
      await this.abrirDetalhesTodasInfracoes(page);
      await page.waitForTimeout(500);
    }

    // Na tela /busca/5anos, cada auto está em um link de accordion (#collapseX).
    // Precisamos clicar em cada auto para abrir os detalhes completos.
    await this.expandirDetalhesPorNumeroAuto(page);

    const multas = await page.evaluate(() => {
      const normalizar = (valor = '') =>
        String(valor || '')
          .replace(/\u00A0/g, ' ')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{2,}/g, '\n')
          .replace(/\s+/g, ' ')
          .trim();

      const safe = (valor) => {
        const limpo = normalizar(valor);
        if (!limpo || /^[-–—*]+$/.test(limpo)) return '-';
        return limpo;
      };

      const canon = (valor = '') =>
        normalizar(valor)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[.:]/g, '')
          .replace(/\s+/g, ' ')
          .toUpperCase()
          .trim();

      const pick = (campos, regexList, fallback = '-') => {
        for (const [chave, valor] of campos.entries()) {
          for (const reg of regexList) {
            if (reg.test(chave)) {
              return safe(valor);
            }
          }
        }
        return fallback;
      };

      const extrairPontosNumerico = (texto = '', enquadramento = '', responsavelPontos = '') => {
        const textoTotal = `${texto} ${enquadramento}`;
        const matches = Array.from(String(textoTotal).matchAll(/PONTOS?\s*:\s*([0-9]{1,3}|\*)/gi))
          .map((m) => safe(m?.[1] || ''))
          .filter((v) => v && v !== '-');
        if (matches.length) return matches[matches.length - 1];

        const bruto = String(texto || '').match(/(?:^|\s)PONTOS?\s*:\s*([^\n\r]+)/i)?.[1] || '';
        const valorBruto = safe(bruto);
        const resp = safe(responsavelPontos);
        if (resp !== '-' && valorBruto.toUpperCase() === resp.toUpperCase()) return '-';
        return valorBruto || '-';
      };

      const paineis = Array.from(document.querySelectorAll('#accordion .panel'));
      if (!paineis.length) return [];

      return paineis.map((panel) => {
        const textoOriginal = normalizar(panel.innerText || panel.textContent || '');
        const texto = textoOriginal.toUpperCase();
        const campos = new Map();

        const grupos = Array.from(panel.querySelectorAll('.col-sm-3, .col-sm-4, .col-sm-6, .col-xs-12'));
        for (const grupo of grupos) {
          const labelEl = grupo.querySelector('label');
          if (!labelEl) continue;

          const chave = canon(labelEl.textContent || '');
          if (!chave) continue;

          const spans = Array.from(grupo.querySelectorAll('span'))
            .map((span) => normalizar(span.textContent || ''))
            .filter(Boolean);

          let valor = safe(spans.join(' '));
          if (valor === '-') {
            const bruto = normalizar((grupo.textContent || '').replace(labelEl.textContent || '', ''));
            valor = safe(bruto);
          }

          const atual = campos.get(chave);
          if (!atual || atual === '-' || (valor !== '-' && valor.length > atual.length)) {
            campos.set(chave, valor);
          }
        }

        const autoSpan = safe(panel.querySelector('.panel-heading .panel-title span')?.textContent || '');
        if (autoSpan !== '-') campos.set('N AUTO', autoSpan);

        const numeroAuto = pick(campos, [/^N[Oº]?\s*AUTO$/, /^AUTO$/i]);
        const data = pick(campos, [/^DATA$/]);
        const orgao = pick(campos, [/^ORGAO$/]);
        const placa = pick(campos, [/^PLACA$/]);
        const proprietario = pick(campos, [/^PROPRIETARIO$/]);
        const responsavelPontos = pick(campos, [/^RESP\s*PONTOS$/]);
        const situacaoBruta = pick(campos, [/^SITUACAO$/]);
        const local = pick(campos, [/^LOCAL$/]);
        const infracao = pick(campos, [/^INFRACAO$/]);
        const enquadramentoComPontos = pick(campos, [/^ENQUADRAMENTO$/]);
        const vencimento = pick(campos, [/^VENCIMENTO$/]);
        const processo = pick(campos, [/^PROCESSO$/]);
        const valor = pick(campos, [/^VALOR$/]);
        const valorComDesconto = pick(campos, [/^VALOR\s+COM\s+DESCONTO$/]);

        const dataPagamentoMatch = String(situacaoBruta || '').match(/PAGA?\s*EM\s*:?\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i);
        const dataPagamento = dataPagamentoMatch ? dataPagamentoMatch[1] : '-';
        const pagamentoStatus = /PAGA?\s*EM|QUITAD|LIQUID/i.test(situacaoBruta)
          ? 'PAGA'
          : /N[AÃ]O\s*PAGA/i.test(situacaoBruta)
          ? 'NAO PAGA'
          : '-';
        const informacaoPagamento = pagamentoStatus === '-'
          ? '-'
          : `${pagamentoStatus}${dataPagamento !== '-' ? ` em ${dataPagamento}` : ''}`;

        const statusAtualLimpo = safe(
          String(situacaoBruta || '')
            .replace(/[-–—]?\s*PAGA?\s*EM\s*:?\s*[0-9]{2}\/[0-9]{2}\/[0-9]{4}/ig, ' ')
            .replace(/\bN[AÃ]O\s*PAGA\b/ig, ' ')
            .replace(/\bPAGA\b/ig, ' ')
            .replace(/\bQUITAD[AO]?\b/ig, ' ')
            .replace(/\bLIQUIDAD[AO]?\b/ig, ' ')
            .replace(/\s*[-–—]\s*/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
        );
        const statusAtual = statusAtualLimpo;

        const pontos = extrairPontosNumerico(texto, enquadramentoComPontos, responsavelPontos);
        const enquadramento = safe(
          String(enquadramentoComPontos || '')
            .replace(/PONTOS?\s*:\s*(?:[0-9]{1,3}|\*)/ig, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
        );

        let status = 'Pendente';
        if (pagamentoStatus === 'PAGA') status = 'Pago';
        else if (pagamentoStatus === 'NAO PAGA') status = 'Nao Pago';
        else if (/cancelad/i.test(situacaoBruta)) status = 'Cancelada';

        return {
          data,
          descricao: infracao !== '-' ? infracao : textoOriginal.slice(0, 200),
          pontos,
          valor,
          valorComDesconto,
          status,
          numeroAuto,
          orgao,
          placa,
          proprietario,
          responsavelPontos,
          situacao: situacaoBruta,
          statusAtual,
          local,
          infracao,
          enquadramento,
          vencimento,
          processo,
          dataPagamento,
          pagamentoStatus,
          informacaoPagamento
        };
      });
    });

    const multasValidas = Array.isArray(multas)
      ? multas.filter((m) => {
          const numeroAuto = String(m?.numeroAuto || '').trim();
          const situacao = String(m?.situacao || '').trim();
          const infracao = String(m?.infracao || '').trim();
          const temNumeroAuto = numeroAuto && numeroAuto !== '-';
          const temDetalhe = (situacao && situacao !== '-') || (infracao && infracao !== '-');
          return temNumeroAuto && temDetalhe;
        })
      : [];

    return multasValidas;
  }

  async expandirDetalhesPorNumeroAuto(page) {
    let linksAuto = page.locator('#accordion a[role="button"][href^="#collapse"], #accordion a[data-toggle="collapse"][href^="#collapse"]');
    let totalLinks = await linksAuto.count();

    // Fallback para layouts antigos
    if (!totalLinks) {
      const totalMarcados = await page.evaluate(() => {
        const normalizar = (valor = '') => String(valor || '').replace(/\s+/g, ' ').trim();
        const ehCodigoAuto = (valor = '') => /^[A-Z]\d{6,}$/i.test(valor) || /^[A-Z0-9-]{7,}$/i.test(valor);

        let idx = 0;
        const links = Array.from(document.querySelectorAll('a'));
        for (const link of links) {
          link.removeAttribute('data-auto-link-detalhe');
          const textoLink = normalizar(link.textContent || '');
          if (!textoLink || !ehCodigoAuto(textoLink)) continue;

          const contexto = normalizar(
            (
              link.closest('tr, div, td, li, p')?.textContent ||
              link.parentElement?.textContent ||
              ''
            ).slice(0, 700)
          );
          if (!/N[º°o]\s*Auto\s*:/i.test(contexto)) continue;

          idx += 1;
          link.setAttribute('data-auto-link-detalhe', String(idx));
        }
        return idx;
      });
      if (!totalMarcados) return 0;
      linksAuto = page.locator('a[data-auto-link-detalhe]');
      totalLinks = await linksAuto.count();
    }

    for (let i = 0; i < totalLinks; i += 1) {
      const link = linksAuto.nth(i);
      const href = await link.getAttribute('href').catch(() => null);
      try {
        await link.click({ timeout: 4000 });
      } catch (e) {}
      if (href && href.startsWith('#')) {
        await page.waitForSelector(`${href}.in, ${href}.show`, { timeout: 3500 }).catch(() => {});
      }
      await page.waitForTimeout(260);
    }

    try {
      await page.waitForFunction(() => {
        const texto = (document.body?.innerText || '').replace(/\u00A0/g, ' ');
        return /Situa[cç][aã]o\s*:|Infra[cç][aã]o\s*:|Enquadramento\s*:|N[º°o]\s*Auto\s*:/i.test(texto);
      }, { timeout: 6000 });
    } catch (e) {}

    return totalLinks;
  }
}

export default PontuacaoAutomation;

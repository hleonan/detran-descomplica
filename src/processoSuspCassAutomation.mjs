import { chromium } from 'playwright';
import TwoCaptcha from './services/TwoCaptchaClass.js';

class ProcessoSuspCassAutomation {
  constructor(apiKey2Captcha) {
    this.twoCaptcha = new TwoCaptcha(apiKey2Captcha);
    this.browser = null;
    this.consultaUrl = '';
    this.tipo = 'suspensao';
    this.cpf = '';
    this.cnh = '';
    this.dataNascimento = '';
    this.dataPrimeiraHabilitacao = '';
  }

  getConsultaUrl(tipo = 'suspensao') {
    if (String(tipo).toLowerCase() === 'cassacao') {
      return 'http://multas.detran.rj.gov.br/gaideweb2/acompanhamentoRecursoCassacao';
    }
    return 'http://multas.detran.rj.gov.br/gaideweb2/acompanhamentoRecursoSuspensao';
  }

  async consultarProcesso(cpf, cnh, dataNascimento, dataPrimeiraHabilitacao, tipo = 'suspensao') {
    try {
      this.tipo = String(tipo || 'suspensao').toLowerCase() === 'cassacao' ? 'cassacao' : 'suspensao';
      this.cpf = String(cpf || '');
      this.cnh = String(cnh || '');
      this.dataNascimento = this.normalizarDataBR(dataNascimento);
      this.dataPrimeiraHabilitacao = this.normalizarDataBR(dataPrimeiraHabilitacao);

      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      const context = await this.browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await this.abrirPaginaConsulta(page);
      const resultado = await this.enviarConsultaComRetryCaptcha(page);

      await context.close();
      await this.browser.close();
      return resultado;
    } catch (error) {
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {}
      }
      throw error;
    }
  }

  normalizarDataBR(valor = '') {
    const texto = String(valor || '').trim();
    if (!texto) return '';

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(texto)) return texto;

    const digits = texto.replace(/\D/g, '');
    if (digits.length === 8) {
      return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    }

    const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;

    return texto;
  }

  async abrirPaginaConsulta(page) {
    const tentativas = [this.getConsultaUrl(this.tipo), this.getConsultaUrl(this.tipo).replace('http://', 'https://')];
    const erros = [];

    const mensagemErro = (err) => String(err?.message || err || '');
    const ehErroConexao = (msg = '') =>
      /(ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|net::)/i.test(msg);

    for (const url of tentativas) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('input[name="cpf"]', { timeout: 15000 });
        this.consultaUrl = page.url();
        return;
      } catch (err) {
        const msg = mensagemErro(err);
        erros.push(msg);
        console.warn(`[PROCESSO] Falha ao abrir URL ${url}: ${msg}`);
      }
    }

    if (erros.some(ehErroConexao)) {
      throw new Error('DETRAN_PROCESSO_OFFLINE: portal de acompanhamento do DETRAN-RJ indisponivel no momento.');
    }

    throw new Error('Falha ao abrir o portal de acompanhamento do DETRAN-RJ.');
  }

  async prepararFormularioConsulta(page) {
    await page.waitForSelector('input[name="cpf"]', { timeout: 15000 });
    await page.fill('input[name="cpf"]', this.cpf);
    await page.fill('input[name="cnh"]', this.cnh);
    await page.fill('input[name="dataNascimento"]', this.dataNascimento);
    await page.fill('input[name="dataPrimeiraHabilitacao"]', this.dataPrimeiraHabilitacao);
  }

  ehErroCaptcha(mensagem = '') {
    return /captcha|recaptcha|nao sou robo|não sou robô|token/i.test(String(mensagem || ''));
  }

  async resolverCaptcha(page, options = {}) {
    const rootSelector = options?.rootSelector || null;

    const captchaInfo = await page.evaluate(({ root }) => {
      const getScope = () => {
        if (!root) return document;
        return document.querySelector(root) || document;
      };

      const scope = getScope();
      const iframe = scope.querySelector('iframe[src*="recaptcha"]') || document.querySelector('iframe[src*="recaptcha"]');
      if (!iframe) return null;

      const src = iframe.getAttribute('src') || '';
      const fromIframe = src.match(/[?&]k=([^&]+)/)?.[1] || null;

      const widget =
        scope.querySelector('.g-recaptcha, [data-sitekey]') ||
        document.querySelector('.g-recaptcha, [data-sitekey]');
      const fromDataSitekey = widget?.getAttribute('data-sitekey') || null;
      const callbackName = widget?.getAttribute('data-callback') || null;

      return {
        sitekey: fromDataSitekey || fromIframe,
        callbackName,
        enterprise:
          /enterprise/i.test(src) || !!document.querySelector('script[src*="recaptcha/enterprise"]'),
        invisible: widget?.getAttribute('data-size') === 'invisible',
      };
    }, { root: rootSelector });

    if (!captchaInfo?.sitekey) {
      throw new Error('Nao foi possível localizar o sitekey do reCAPTCHA.');
    }

    const captchaId = await this.twoCaptcha.uploadReCaptcha(captchaInfo.sitekey, this.consultaUrl || page.url(), {
      enterprise: captchaInfo.enterprise,
      invisible: captchaInfo.invisible,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const token = await this.twoCaptcha.obterResultado(captchaId);

    await page.evaluate(
      ({ resolvedToken, callbackName, root }) => {
        const scope = root ? document.querySelector(root) || document : document;
        const fields = Array.from(
          new Set([
            ...scope.querySelectorAll('#g-recaptcha-response, textarea[name="g-recaptcha-response"]'),
            ...document.querySelectorAll('#g-recaptcha-response, textarea[name="g-recaptcha-response"]'),
          ])
        );

        fields.forEach((field) => {
          field.innerHTML = resolvedToken;
          field.value = resolvedToken;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        });

        if (callbackName && typeof window[callbackName] === 'function') {
          window[callbackName](resolvedToken);
        }
      },
      {
        resolvedToken: token,
        callbackName: captchaInfo.callbackName,
        root: rootSelector,
      }
    );

    await page.waitForTimeout(400);
    return token;
  }

  async enviarConsultaComRetryCaptcha(page) {
    let ultimoErro = null;

    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
      try {
        await this.prepararFormularioConsulta(page);
        console.log(`[PROCESSO] Resolvendo CAPTCHA inicial (tentativa ${tentativa}/2)...`);
        const token = await this.resolverCaptcha(page);
        if (!token) throw new Error('Falha ao resolver CAPTCHA inicial (token não retornado).');

        const btnConsultar = page
          .locator('button[name="nameConsultar"], button[type="submit"], input[type="submit"], button:has-text("Consultar"), input[value*="Consultar" i]')
          .first();

        await btnConsultar.waitFor({ state: 'visible', timeout: 12000 });

        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
          btnConsultar.click({ timeout: 6000 }),
        ]);

        const resultado = await this.capturarResultado(page);
        if (resultado.sucesso) return resultado;

        if (!this.ehErroCaptcha(resultado.erro) || tentativa === 2) {
          return resultado;
        }

        ultimoErro = resultado.erro;
        await this.abrirPaginaConsulta(page);
      } catch (err) {
        ultimoErro = err?.message || String(err);
        if (/DETRAN_PROCESSO_OFFLINE/i.test(ultimoErro) || tentativa === 2) {
          throw err;
        }
        await this.abrirPaginaConsulta(page);
      }
    }

    throw new Error(ultimoErro || 'Falha ao consultar processo no DETRAN-RJ.');
  }

  async capturarResultado(page) {
    await page.waitForSelector('body', { timeout: 12000 });

    const erroTela = await page.evaluate(() => {
      const texto = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!texto) return 'Pagina de resultado vazia.';

      const padroesErro = [
        /dados invalido/i,
        /nao foi possivel/i,
        /erro ao consultar/i,
        /captcha invalido/i,
        /token invalido/i,
      ];

      for (const padrao of padroesErro) {
        if (padrao.test(texto)) {
          return texto.slice(0, 350);
        }
      }

      return null;
    });

    if (erroTela) {
      return { sucesso: false, erro: `DETRAN retornou erro na consulta de processo. ${erroTela}` };
    }

    const resumo = await this.extrairResumoProcessos(page);

    if (!Array.isArray(resumo.processos) || resumo.processos.length === 0) {
      return {
        sucesso: true,
        tipo: this.tipo,
        condutor: resumo.condutor,
        processos: [],
        mensagem: resumo.mensagem || 'Nenhum processo encontrado.',
      };
    }

    const processosDetalhados = [];
    for (const processo of resumo.processos.slice(0, 10)) {
      const item = { ...processo };
      try {
        const detalhes = await this.exibirEExtrairDetalheProcesso(page, processo.numeroProcesso);
        if (detalhes) item.detalhes = detalhes;
      } catch (err) {
        console.warn(`[PROCESSO] Falha ao extrair detalhes do processo ${processo.numeroProcesso}: ${err?.message || err}`);
        item.detalheErro = err?.message || String(err);
      }
      processosDetalhados.push(item);
    }

    return {
      sucesso: true,
      tipo: this.tipo,
      condutor: resumo.condutor,
      processos: processosDetalhados,
      mensagem: resumo.mensagem || null,
      dataConsulta: new Date().toISOString(),
    };
  }

  async extrairResumoProcessos(page) {
    return page.evaluate(() => {
      const normalizar = (valor = '') => String(valor || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
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
          .toUpperCase();

      const extrairTabela = (table) => {
        const headers = Array.from(table.querySelectorAll('thead th')).map((th) => safe(th.textContent));
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) => safe(td.textContent))
        );
        return { headers, rows, table };
      };

      const tabelas = Array.from(document.querySelectorAll('table')).map(extrairTabela);

      let condutor = { nome: '-', cpf: '-', cnh: '-' };
      for (const tabela of tabelas) {
        const headers = tabela.headers.map(canon);
        if (headers.includes('NOME') && headers.includes('CPF') && headers.includes('CNH') && tabela.rows.length) {
          const row = tabela.rows[0];
          condutor = {
            nome: safe(row[headers.indexOf('NOME')]),
            cpf: safe(row[headers.indexOf('CPF')]),
            cnh: safe(row[headers.indexOf('CNH')]),
          };
          break;
        }
      }

      const processos = [];
      for (const tabela of tabelas) {
        const headers = tabela.headers.map(canon);
        if (!(headers.includes('PROCESSO') && headers.includes('SITUACAO ATUAL'))) continue;

        const idxProcesso = headers.indexOf('PROCESSO');
        const idxData = headers.indexOf('DATA DO PROCESSO');
        const idxSituacao = headers.indexOf('SITUACAO ATUAL');
        const idxPrazo = headers.indexOf('PRAZO SUSPENSAO');
        const idxMultas = headers.indexOf('TOTAL DE MULTAS');
        const idxPontos = headers.indexOf('TOTAL DE PONTOS');

        const trs = Array.from(tabela.table.querySelectorAll('tbody tr'));
        trs.forEach((tr, index) => {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (!tds.length) return;

          const textoProcesso = safe(tds[idxProcesso]?.innerText || tds[idxProcesso]?.textContent || '');
          const numeroMatch = textoProcesso.match(/[A-Z]-?\d{2}\/\d{3}\/\d{4,7}\/\d{4}|E-\d{2}\/\d{3}\/\d{6}\/\d{4}|[A-Z0-9-]{6,}/i);
          const numeroProcesso = safe(numeroMatch?.[0] || textoProcesso);
          if (numeroProcesso === '-') return;

          const link = tds[idxProcesso]?.querySelector('a, img.pointer') || null;

          processos.push({
            numeroProcesso,
            dataProcesso: safe(idxData >= 0 ? tds[idxData]?.innerText : '-'),
            situacaoAtual: safe(idxSituacao >= 0 ? tds[idxSituacao]?.innerText : '-'),
            prazoSuspensao: safe(idxPrazo >= 0 ? tds[idxPrazo]?.innerText : '-'),
            totalMultas: safe(idxMultas >= 0 ? tds[idxMultas]?.innerText : '-'),
            totalPontos: safe(idxPontos >= 0 ? tds[idxPontos]?.innerText : '-'),
            possuiDetalhe: Boolean(link),
            rowIndex: index,
          });
        });

        if (processos.length) break;
      }

      const mensagem = safe(
        Array.from(document.querySelectorAll('.alert, .alert-info, .text-info, .text-danger, p, div'))
          .map((el) => normalizar(el.textContent))
          .find((txt) =>
            /Existe mais de um processo|nenhum processo|não existem processos|nao existem processos/i.test(txt)
          ) ||
          ''
      );

      return {
        condutor,
        processos,
        mensagem: mensagem === '-' ? null : mensagem,
      };
    });
  }

  async exibirEExtrairDetalheProcesso(page, numeroProcesso) {
    const row = page.locator('tr', { hasText: numeroProcesso }).first();
    if (!(await row.count())) return null;

    const trigger = row
      .locator('a:has(img), a[role="button"], a[href*="javascript"], a[href^="#"], img.pointer')
      .first();
    if (!(await trigger.count())) return null;

    await trigger.click({ timeout: 6000 }).catch(() => null);
    await page.waitForTimeout(350);

    const modalAberto = await page
      .evaluate(() => {
        const modal = document.querySelector('#idAlertModal, .modal.fade.alertModal, .modal.in, .modal.show');
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .catch(() => false);

    if (modalAberto) {
      const temCaptchaModal =
        (await page.locator('#idAlertModal iframe[src*="recaptcha"], .modal iframe[src*="recaptcha"]').count()) > 0;
      if (temCaptchaModal) {
        console.log(`[PROCESSO] Resolvendo CAPTCHA do modal para processo ${numeroProcesso}...`);
        const token = await this.resolverCaptcha(page, { rootSelector: '#idAlertModal' });
        if (!token) throw new Error('Falha ao resolver CAPTCHA do modal de exibição do processo.');
      }

      const btnExibir = page
        .locator(
          '#idAlertModal button:has-text("Exibir"), #idAlertModal input[value*="Exibir" i], .modal button:has-text("Exibir"), .modal .btn-primary'
        )
        .first();

      if (await btnExibir.count()) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {}),
          btnExibir.click({ timeout: 5000 }).catch(() => null),
        ]);
      }

      await page.waitForTimeout(800);
    }

    await page
      .waitForFunction(
        ({ numero }) => {
          const texto = (document.body?.innerText || '').replace(/\s+/g, ' ').toUpperCase();
          return (
            texto.includes(String(numero).toUpperCase()) &&
            (/INFRA[CÇ][AÃ]O|ANDAMENTOS|PRAZO/i.test(texto) || /DADOS DO PROCESSO/i.test(texto))
          );
        },
        { numero: numeroProcesso, timeout: 12000 }
      )
      .catch(() => {});

    return this.extrairDetalhesProcesso(page, numeroProcesso);
  }

  async extrairDetalhesProcesso(page, numeroProcesso) {
    return page.evaluate((numeroAlvo) => {
      const normalizar = (valor = '') => String(valor || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      const safe = (valor) => {
        const limpo = normalizar(valor);
        if (!limpo || /^[-–—*x\/]+$/i.test(limpo)) return '-';
        return limpo;
      };
      const canon = (valor = '') =>
        normalizar(valor)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[.:]/g, '')
          .toUpperCase();

      const tables = Array.from(document.querySelectorAll('table')).map((table) => {
        const headers = Array.from(table.querySelectorAll('thead th')).map((th) => safe(th.textContent));
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) => safe(td.textContent))
        );
        return { table, headers, rows, headersCanon: headers.map(canon) };
      });

      let dadosProcesso = null;
      const prazos = [];
      const infracoes = [];
      const andamentos = [];

      for (const t of tables) {
        const h = t.headersCanon;

        if (h.includes('PROCESSO') && h.includes('SITUACAO ATUAL') && t.rows.length) {
          const idxProc = h.indexOf('PROCESSO');
          const idxData = h.indexOf('DATA DO PROCESSO');
          const idxSit = h.indexOf('SITUACAO ATUAL');
          const idxPrazo = h.indexOf('PRAZO SUSPENSAO');
          const idxMultas = h.indexOf('TOTAL DE MULTAS');
          const idxPontos = h.indexOf('TOTAL DE PONTOS');

          const row = t.rows.find((r) => canon(r[idxProc] || '').includes(canon(numeroAlvo))) || t.rows[0];
          dadosProcesso = {
            numeroProcesso: safe(row[idxProc]),
            dataProcesso: safe(idxData >= 0 ? row[idxData] : '-'),
            situacaoAtual: safe(idxSit >= 0 ? row[idxSit] : '-'),
            prazoSuspensao: safe(idxPrazo >= 0 ? row[idxPrazo] : '-'),
            totalMultas: safe(idxMultas >= 0 ? row[idxMultas] : '-'),
            totalPontos: safe(idxPontos >= 0 ? row[idxPontos] : '-'),
          };
          continue;
        }

        if (h.includes('AUTO DE INFRACAO') || h.includes('AUTO INFRAÇÃO')) {
          const idxAuto = h.indexOf('AUTO DE INFRACAO');
          const idxPlaca = h.indexOf('PLACA');
          const idxOrgao = h.indexOf('ORGAO');
          const idxData = h.indexOf('DATA');
          const idxHora = h.indexOf('HORA');
          const idxEnq = h.indexOf('ENQUADRAMENTO');
          const idxDesc = h.indexOf('DESCRICAO');
          const idxPontos = h.indexOf('PONTOS');

          t.rows.forEach((r) => {
            const auto = safe(idxAuto >= 0 ? r[idxAuto] : '-');
            if (auto === '-') return;
            infracoes.push({
              autoInfracao: auto,
              placa: safe(idxPlaca >= 0 ? r[idxPlaca] : '-'),
              orgao: safe(idxOrgao >= 0 ? r[idxOrgao] : '-'),
              data: safe(idxData >= 0 ? r[idxData] : '-'),
              hora: safe(idxHora >= 0 ? r[idxHora] : '-'),
              enquadramento: safe(idxEnq >= 0 ? r[idxEnq] : '-'),
              descricao: safe(idxDesc >= 0 ? r[idxDesc] : '-'),
              pontos: safe(idxPontos >= 0 ? r[idxPontos] : '-'),
            });
          });
          continue;
        }

        if (h.some((col) => col.includes('PRAZO'))) {
          const row = t.rows[0] || [];
          if (row.length) {
            const obj = {};
            t.headers.forEach((label, idx) => {
              obj[safe(label)] = safe(row[idx]);
            });
            prazos.push(obj);
          }
          continue;
        }

        if (t.rows.length && t.rows.every((r) => (r[0] || '').endsWith(':'))) {
          const obj = {};
          t.rows.forEach((r) => {
            const chave = safe(r[0]).replace(/:$/, '');
            const valor = safe(r[1] || '-');
            if (chave !== '-') obj[chave] = valor;
          });
          if (Object.keys(obj).length) andamentos.push(obj);
        }
      }

      return {
        dadosProcesso,
        prazos,
        infracoes,
        andamentos,
      };
    }, numeroProcesso);
  }
}

export default ProcessoSuspCassAutomation;

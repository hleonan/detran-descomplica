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
          '--disable-gpu',
          '--single-process'
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

      await page.goto('http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });

      await page.fill('input[name="cpf"]', cpf);
      await page.fill('input[name="cnh"]', cnh);
      await page.selectOption('select[name="uf"]', uf || 'RJ');

      console.log('[MULTAS] Resolvendo CAPTCHA...');
      const captchaToken = await this.resolverCaptcha(page);
      if (!captchaToken) throw new Error('Falha ao resolver CAPTCHA');

      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
        page.click('button[type="submit"]')
      ]);

      const resultado = await this.capturarResultado(page);

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

  async resolverCaptcha(page) {
    try {
      const captchaElement = await page.$('iframe[src*="recaptcha"]');
      
      if (!captchaElement) {
        const imagemCaptcha = await page.$('img[alt*="captcha"]');
        if (imagemCaptcha) {
          const screenshot = await imagemCaptcha.screenshot();
          const captchaId = await this.twoCaptcha.uploadCaptcha(screenshot);
          const token = await this.twoCaptcha.obterResultado(captchaId);
          return token;
        }
        return null;
      }

      const sitekey = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="recaptcha"]');
        const src = iframe?.src || '';
        const match = src.match(/k=([^&]+)/);
        return match ? match[1] : null;
      });

      if (!sitekey) {
        throw new Error('Não foi possível extrair o sitekey do reCAPTCHA');
      }

      const captchaId = await this.twoCaptcha.uploadReCaptcha(
        sitekey,
        'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao'
      );

      const token = await this.twoCaptcha.obterResultado(captchaId);
      
      await page.evaluate((resolvedToken) => {
        const responseField = document.getElementById('g-recaptcha-response');
        if (responseField) {
          responseField.innerHTML = resolvedToken;
          responseField.value = resolvedToken;
        }
      }, token);

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
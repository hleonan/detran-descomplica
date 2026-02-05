import { chromium } from 'playwright';
import TwoCaptcha from './services/TwoCaptchaClass.js';

/**
 * Automação para consultar pontuação/multas no DETRAN-RJ
 * URL: http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao
 */

class PontuacaoAutomation {
  constructor(apiKey2Captcha ) {
    this.twoCaptcha = new TwoCaptcha(apiKey2Captcha);
    this.browser = null;
  }

  async consultarPontuacao(cpf, cnh, uf = 'RJ') {
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const context = await this.browser.createBrowserContext();
      const page = await context.newPage();

      // Navegar para a página de consulta
      await page.goto('http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao', {
        waitUntil: 'networkidle'
      } );

      // Preencher CPF
      await page.fill('input[name="cpf"]', cpf);
      
      // Preencher CNH
      await page.fill('input[name="cnh"]', cnh);
      
      // Selecionar UF
      await page.selectOption('select[name="uf"]', uf);

      // Resolver CAPTCHA
      console.log('Resolvendo CAPTCHA...');
      const captchaToken = await this.resolverCaptcha(page);
      
      if (!captchaToken) {
        throw new Error('Falha ao resolver CAPTCHA');
      }

      // Enviar formulário
      await page.click('button[type="submit"]');
      
      // Aguardar resultado
      await page.waitForNavigation({ waitUntil: 'networkidle' });

      // Capturar resultado
      const resultado = await this.capturarResultado(page);

      await context.close();
      await this.browser.close();

      return resultado;
    } catch (error) {
      if (this.browser) {
        await this.browser.close();
      }
      throw error;
    }
  }

  async resolverCaptcha(page) {
    try {
      // Capturar screenshot do CAPTCHA
      const captchaElement = await page.$('iframe[src*="recaptcha"]');
      
      if (!captchaElement) {
        // Se não houver iframe, pode ser CAPTCHA de imagem
        const imagemCaptcha = await page.$('img[alt*="captcha"]');
        if (imagemCaptcha) {
          const screenshot = await imagemCaptcha.screenshot();
          const captchaId = await this.twoCaptcha.uploadCaptcha(screenshot);
          const token = await this.twoCaptcha.obterResultado(captchaId);
          return token;
        }
        return null;
      }

      // Para reCAPTCHA, usar método diferente
      const sitekey = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="recaptcha"]');
        const src = iframe?.src || '';
        const match = src.match(/k=([^&]+)/);
        return match ? match[1] : null;
      });

      if (!sitekey) {
        throw new Error('Não foi possível extrair o sitekey do reCAPTCHA');
      }

      // Usar 2Captcha para resolver reCAPTCHA
      const captchaId = await this.twoCaptcha.uploadReCaptcha(
        sitekey,
        'http://multas.detran.rj.gov.br/gaideweb2/consultaPontuacao'
       );

      const token = await this.twoCaptcha.obterResultado(captchaId);
      
      // Injetar token no formulário
      await page.evaluate((token) => {
        const responseField = document.getElementById('g-recaptcha-response');
        if (responseField) {
          responseField.innerHTML = token;
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
      // Aguardar a página de resultado carregar
      await page.waitForSelector('table, div[class*="resultado"]', { timeout: 10000 });

      // Capturar HTML da página
      const html = await page.content();

      // Extrair dados da tabela de multas
      const multas = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        const dados = [];

        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0) {
            dados.push({
              data: cells[0]?.textContent?.trim() || '',
              descricao: cells[1]?.textContent?.trim() || '',
              pontos: cells[2]?.textContent?.trim() || '',
              valor: cells[3]?.textContent?.trim() || '',
              status: cells[4]?.textContent?.trim() || ''
            });
          }
        });

        return dados;
      });

      // Extrair resumo (pontos totais, multas pendentes, etc)
      const resumo = await page.evaluate(() => {
        const texto = document.body.innerText;
        return {
          pontosTotais: texto.match(/Pontos totais?:?\s*(\d+)/i)?.[1] || '0',
          multasPendentes: texto.match(/Multas pendentes?:?\s*(\d+)/i)?.[1] || '0',
          situacao: texto.match(/Situação?:?\s*([^\n]+)/i)?.[1] || 'Desconhecida'
        };
      });

      return {
        sucesso: true,
        multas: multas,
        resumo: resumo,
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
}

export default PontuacaoAutomation;

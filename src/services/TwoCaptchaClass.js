// src/services/TwoCaptchaClass.js
/**
 * Classe para integração com 2Captcha API
 * Documentação: https://2captcha.com/api-docs
 */
class TwoCaptcha {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://2captcha.com';
  }

  /**
   * Upload de CAPTCHA de imagem
   * @param {Buffer} imageBuffer - Buffer da imagem do CAPTCHA
   * @returns {Promise<string>} ID do CAPTCHA
   */
  async uploadCaptcha(imageBuffer) {
    const formData = new FormData();
    formData.append('key', this.apiKey);
    formData.append('method', 'base64');
    formData.append('body', imageBuffer.toString('base64'));
    formData.append('json', '1');

    const response = await fetch(`${this.baseUrl}/in.php`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.status !== 1) {
      throw new Error(`2Captcha erro: ${data.request || 'Erro ao enviar CAPTCHA'}`);
    }

    return data.request; // ID do CAPTCHA
  }

  /**
   * Upload de reCAPTCHA v2
   * @param {string} sitekey - Sitekey do reCAPTCHA
   * @param {string} pageUrl - URL da página com o reCAPTCHA
   * @returns {Promise<string>} ID do CAPTCHA
   */
  async uploadReCaptcha(sitekey, pageUrl) {
    const url = `${this.baseUrl}/in.php?` +
      `key=${encodeURIComponent(this.apiKey)}` +
      `&method=userrecaptcha` +
      `&googlekey=${encodeURIComponent(sitekey)}` +
      `&pageurl=${encodeURIComponent(pageUrl)}` +
      `&json=1`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 1) {
      throw new Error(`2Captcha erro: ${data.request || 'Erro ao enviar reCAPTCHA'}`);
    }

    return data.request; // ID do CAPTCHA
  }

  /**
   * Obter resultado do CAPTCHA
   * @param {string} captchaId - ID do CAPTCHA retornado pelo upload
   * @returns {Promise<string>} Token/texto resolvido
   */
  async obterResultado(captchaId) {
    const maxAttempts = 30; // 30 tentativas = ~2 minutos
    const delayMs = 5000; // 5 segundos entre tentativas

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(delayMs);

      const url = `${this.baseUrl}/res.php?` +
        `key=${encodeURIComponent(this.apiKey)}` +
        `&action=get` +
        `&id=${encodeURIComponent(captchaId)}` +
        `&json=1`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status === 1) {
        return data.request; // Token resolvido
      }

      if (data.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2Captcha erro: ${data.request}`);
      }

      // Continua tentando...
    }

    throw new Error('Timeout ao aguardar resolução do CAPTCHA');
  }

  /**
   * Helper para aguardar
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Obter saldo da conta
   */
  async getBalance() {
    const url = `${this.baseUrl}/res.php?` +
      `key=${encodeURIComponent(this.apiKey)}` +
      `&action=getbalance` +
      `&json=1`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 1) {
      throw new Error(`2Captcha erro: ${data.request || 'Erro ao obter saldo'}`);
    }

    return data.request; // Saldo como string
  }
}

export default TwoCaptcha;

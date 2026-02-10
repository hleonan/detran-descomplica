import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extrator de OCR usando Google Vision API
 * Extrai CPF e CNH de imagens de documentos
 */

class OCRExtractor {
  constructor(googleApiKey) {
    this.apiKey = googleApiKey;
    this.googleVisionUrl = 'https://vision.googleapis.com/v1/images:annotate';
  }

  /**
   * Extrair texto de imagem usando Google Vision API (método base)
   */
  async extrairTextoImagem(caminhoArquivo) {
    try {
      // Ler arquivo
      const buffer = fs.readFileSync(caminhoArquivo);
      const base64 = buffer.toString('base64');

      // Chamar Google Vision API
      if (!this.apiKey) throw new Error("Chave do Google Vision não informada.");

      const response = await fetch(`${this.googleVisionUrl}?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              image: {
                content: base64
              },
              features: [
                {
                  type: 'TEXT_DETECTION'
                }
              ]
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`Erro na API Google Vision: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.responses[0].error) {
        throw new Error(`Erro Google Vision: ${data.responses[0].error.message}`);
      }

      // Extrair texto completo
      const textoCompleto = data.responses[0].fullTextAnnotation?.text || '';

      // Extrair dados da CNH do texto
      const dados = this.extrairDadosDoTexto(textoCompleto);

      return {
        sucesso: true,
        dados: dados,
        textoCompleto: textoCompleto,
        confianca: this.calcularConfianca(dados.cpf, dados.cnh)
      };
    } catch (error) {
      console.error('Erro ao extrair texto:', error);
      return {
        sucesso: false,
        erro: error.message
      };
    }
  }

  /**
   * Extrair dados específicos da CNH a partir do texto OCR
   */
  extrairDadosDoTexto(texto) {
    if (!texto) return { cpf: null, cnh: null, nome: null };

    // Extrair CPF (padrão: XXX.XXX.XXX-XX ou XXXXXXXXXXX)
    const cpfMatch = texto.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
    const cpf = cpfMatch ? this.normalizarCPF(cpfMatch[1]) : null;

    // Extrair CNH - múltiplas estratégias
    let cnh = null;
    
    // Estratégia 1: Procura "Registro" ou "CNH" seguido de números
    const cnhMatch1 = texto.match(/(?:Registro|N[°º]?\s*Registro|CNH)[:\s]*(\d{9,12})/i);
    if (cnhMatch1) cnh = cnhMatch1[1];
    
    // Estratégia 2: Procura números de 11 dígitos que não sejam CPF
    if (!cnh) {
      const cpfDigits = cpf ? cpf.replace(/\D/g, '') : '';
      const allNumbers = texto.match(/\b\d{11}\b/g) || [];
      for (const num of allNumbers) {
        if (num !== cpfDigits) {
          cnh = num;
          break;
        }
      }
    }

    // Estratégia 3: Procura sequência de 9-12 dígitos após "Registro"
    if (!cnh) {
      const cnhMatch3 = texto.match(/(\d{9,12})\s*(?:CNH|Registro)/i);
      if (cnhMatch3) cnh = cnhMatch3[1];
    }

    // Extrair nome
    const nomeMatch = texto.match(/Nome[:\s]*([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇa-záéíóúâêîôûãõç\s]+)/i);
    const nome = nomeMatch ? nomeMatch[1].trim() : null;

    return {
      cpf: cpf,
      cnh: cnh,
      nome: nome
    };
  }

  /**
   * Extrair dados específicos da CNH (alias para compatibilidade)
   */
  async extrairDadosCNH(caminhoArquivo) {
    return this.extrairTextoImagem(caminhoArquivo);
  }

  /**
   * Validar CPF extraído
   */
  validarCPF(cpf) {
    if (!cpf) return false;

    const numeros = cpf.replace(/\D/g, '');

    if (numeros.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(numeros)) return false;

    let soma = 0;
    for (let i = 0; i < 9; i++) {
      soma += parseInt(numeros[i]) * (10 - i);
    }
    let resto = soma % 11;
    let digito1 = resto < 2 ? 0 : 11 - resto;

    if (parseInt(numeros[9]) !== digito1) return false;

    soma = 0;
    for (let i = 0; i < 10; i++) {
      soma += parseInt(numeros[i]) * (11 - i);
    }
    resto = soma % 11;
    let digito2 = resto < 2 ? 0 : 11 - resto;

    if (parseInt(numeros[10]) !== digito2) return false;

    return true;
  }

  /**
   * Normalizar CPF (remover formatação)
   */
  normalizarCPF(cpf) {
    return cpf.replace(/\D/g, '');
  }

  /**
   * Calcular confiança da extração
   */
  calcularConfianca(cpf, cnh) {
    let confianca = 0;

    if (cpf && this.validarCPF(cpf)) confianca += 40;
    else if (cpf) confianca += 20;

    if (cnh && cnh.length >= 9) confianca += 40;
    else if (cnh) confianca += 20;

    return Math.min(confianca, 100);
  }

  /**
   * Obter tipo MIME do arquivo
   */
  obterTipoMidia(extensao) {
    const tipos = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf'
    };

    return tipos[extensao.toLowerCase()] || 'image/jpeg';
  }
}

export default OCRExtractor;

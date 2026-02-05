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
   * Extrair texto de imagem usando Google Vision API
   */
  async extrairTextoImagem(caminhoArquivo ) {
    try {
      // Ler arquivo
      const buffer = fs.readFileSync(caminhoArquivo);
      const base64 = buffer.toString('base64');

      // Determinar tipo de mídia
      const ext = path.extname(caminhoArquivo).toLowerCase();
      const tipoMidia = this.obterTipoMidia(ext);

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

      return {
        sucesso: true,
        textoCompleto: textoCompleto,
        anotacoes: data.responses[0].textAnnotations || []
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
   * Extrair dados específicos da CNH
   */
  async extrairDadosCNH(caminhoArquivo) {
    try {
      // Extrair texto da imagem
      const resultado = await this.extrairTextoImagem(caminhoArquivo);

      if (!resultado.sucesso) {
        return resultado;
      }

      const texto = resultado.textoCompleto;

      // Extrair CPF (padrão: XXX.XXX.XXX-XX)
      const cpfMatch = texto.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
      const cpf = cpfMatch ? this.normalizarCPF(cpfMatch[1]) : null;

      // Extrair CNH (padrão: números de 9-12 dígitos)
      const cnhMatch = texto.match(/CNH[:\s]*(\d{9,12})/i) || 
                       texto.match(/(?:Registro|Número)[:\s]*(\d{9,12})/i) ||
                       texto.match(/(\d{9,12})\s*(?:CNH|Registro)/i);
      const cnh = cnhMatch ? cnhMatch[1] : null;

      // Extrair nome
      const nomeMatch = texto.match(/Nome[:\s]*([A-ZÁÉÍÓÚ][A-ZÁÉÍÓÚa-záéíóú\s]+)/i);
      const nome = nomeMatch ? nomeMatch[1].trim() : null;

      // Extrair data de nascimento (padrão: DD/MM/YYYY ou DD-MM-YYYY)
      const dataNascimentoMatch = texto.match(/(\d{2}[/-]\d{2}[/-]\d{4})/);
      const dataNascimento = dataNascimentoMatch ? dataNascimentoMatch[1] : null;

      // Extrair categoria (A, B, C, D, E, AB, AC, AD, AE)
      const categoriaMatch = texto.match(/Categoria[:\s]*([A-E]{1,2})/i);
      const categoria = categoriaMatch ? categoriaMatch[1] : null;

      // Extrair validade (data de vencimento)
      const validadeMatch = texto.match(/Válida até[:\s]*(\d{2}[/-]\d{2}[/-]\d{4})/i) ||
                           texto.match(/Vencimento[:\s]*(\d{2}[/-]\d{2}[/-]\d{4})/i);
      const validade = validadeMatch ? validadeMatch[1] : null;

      return {
        sucesso: true,
        dados: {
          cpf: cpf,
          cnh: cnh,
          nome: nome,
          dataNascimento: dataNascimento,
          categoria: categoria,
          validade: validade
        },
        textoCompleto: texto,
        confianca: this.calcularConfianca(cpf, cnh)
      };
    } catch (error) {
      console.error('Erro ao extrair dados CNH:', error);
      return {
        sucesso: false,
        erro: error.message
      };
    }
  }

  /**
   * Validar CPF extraído
   */
  validarCPF(cpf) {
    if (!cpf) return false;

    const numeros = cpf.replace(/\D/g, '');

    if (numeros.length !== 11) return false;

    // Verificar se todos os dígitos são iguais
    if (/^(\d)\1{10}$/.test(numeros)) return false;

    // Validar primeiro dígito verificador
    let soma = 0;
    for (let i = 0; i < 9; i++) {
      soma += parseInt(numeros[i]) * (10 - i);
    }
    let resto = soma % 11;
    let digito1 = resto < 2 ? 0 : 11 - resto;

    if (parseInt(numeros[9]) !== digito1) return false;

    // Validar segundo dígito verificador
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

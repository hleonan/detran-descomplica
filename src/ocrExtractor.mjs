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
    if (!texto) {
      return {
        cpf: null,
        cnh: null,
        nome: null,
        dataNascimento: null,
        dataPrimeiraHabilitacao: null,
        validadeCnh: null,
        categoriaCnh: null,
        docIdentidade: null,
        orgaoEmissor: null,
        ufEmissor: null,
        dataEmissaoCnh: null,
        localEmissaoCnh: null,
      };
    }

    const textoSeguro = String(texto || "").replace(/\r/g, "\n");
    const linhas = textoSeguro
      .split(/\n+/)
      .map((linha) => linha.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const limparCampo = (valor) => {
      const textoValor = String(valor || "").replace(/\s+/g, " ").trim();
      return textoValor || null;
    };

    const extrairComRegex = (regexes = []) => {
      for (const regex of regexes) {
        const match = textoSeguro.match(regex);
        if (match?.[1]) {
          const valor = limparCampo(match[1]);
          if (valor) return valor;
        }
      }
      return null;
    };

    const extrairDataPorRotulos = (rotulos = []) => {
      for (const rotuloRegex of rotulos) {
        const regex = new RegExp(
          `${rotuloRegex.source}[^\\n\\r\\d]{0,25}(\\d{2}[\\/\\-.]\\d{2}[\\/\\-.]\\d{4})`,
          "i"
        );
        const match = textoSeguro.match(regex);
        if (match?.[1]) return normalizarData(match[1]);
      }
      return null;
    };

    // Extrair CPF (padrão: XXX.XXX.XXX-XX ou XXXXXXXXXXX)
    const cpfMatch = textoSeguro.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
    const cpf = cpfMatch ? this.normalizarCPF(cpfMatch[1]) : null;

    // Extrair CNH - múltiplas estratégias
    let cnh = null;
    
    // Estratégia 1: Procura "Registro" ou "CNH" seguido de números
    const cnhMatch1 = textoSeguro.match(/(?:N[°ºo]?\s*Registro|Registro|N[°ºo]?\s*CNH|CNH|Numero\s*CNH)[:\s]*(\d{9,12})/i);
    if (cnhMatch1) cnh = cnhMatch1[1];
    
    // Estratégia 2: Procura números de 11 dígitos que não sejam CPF
    if (!cnh) {
      const cpfDigits = cpf ? cpf.replace(/\D/g, '') : '';
      const allNumbers = textoSeguro.match(/\b\d{11}\b/g) || [];
      for (const num of allNumbers) {
        if (num !== cpfDigits) {
          cnh = num;
          break;
        }
      }
    }

    // Estratégia 3: Procura sequência de 9-12 dígitos após "Registro"
    if (!cnh) {
      const cnhMatch3 = textoSeguro.match(/(\d{9,12})\s*(?:CNH|Registro)/i);
      if (cnhMatch3) cnh = cnhMatch3[1];
    }

    // Extrair nome (CNH antiga e nova)
    let nome = extrairComRegex([
      /\bNOME\b[:\s]*([A-ZÀ-Ú][A-ZÀ-Ú'\- ]{4,}?)(?=\s{2,}|DOC\.?\s*IDENT|CPF|DATA\s*NASC|FILIA|PERMISSAO|VALIDADE|CAT\.?\s*HAB|N[°ºo]?\s*REGISTRO|$)/i,
    ]);

    if (!nome) {
      const idxNome = linhas.findIndex((linha) => /^NOME\b/i.test(linha));
      if (idxNome >= 0) {
        const linhaNome = linhas[idxNome].replace(/^NOME[:\s]*/i, "").trim();
        if (linhaNome && !/^(DOC|CPF|DATA|FILIA|REGISTRO|N[°ºo])/i.test(linhaNome)) {
          nome = linhaNome;
        } else {
          const proximaLinha = linhas[idxNome + 1] || "";
          if (/^[A-ZÀ-Ú][A-ZÀ-Ú'\- ]{4,}$/i.test(proximaLinha)) nome = proximaLinha;
        }
      }
    }

    const normalizarData = (valor) => {
      const textoData = String(valor || '').trim();
      if (!textoData) return null;
      const digits = textoData.replace(/\D/g, '');
      if (digits.length !== 8) return null;
      return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    };

    const dataNascimento = extrairDataPorRotulos([
      /DATA\s+NASC(?:IMENTO)?/,
      /NASCIMENTO/,
    ]);

    const dataPrimeiraHabilitacao = extrairDataPorRotulos([
      /1\s*[ªA]?\s*HABILITA/,
      /PRIMEIRA\s+HABILITA/,
    ]);

    const validadeCnh = extrairDataPorRotulos([/VALIDADE/]);
    const dataEmissaoCnh = extrairDataPorRotulos([/DATA\s+EMISS[ÃA]O/, /EMISS[ÃA]O/]);

    let categoriaCnh = extrairComRegex([
      /CAT\.?\s*HAB\.?[:\s]*([A-Z]{1,3})/i,
      /CATEGORIA[:\s]*([A-Z]{1,3})/i,
    ]);
    if (categoriaCnh) categoriaCnh = categoriaCnh.toUpperCase();

    let docIdentidade = extrairComRegex([
      /DOC\.?\s*IDENTIDADE[^:\n\r]*[:\s]*([A-Z0-9.\-\/ ]{5,})/i,
      /DOC\.?\s*IDENT[^:\n\r]*[:\s]*([A-Z0-9.\-\/ ]{5,})/i,
    ]);

    if (!docIdentidade) {
      const idxDoc = linhas.findIndex((linha) => /DOC\.?\s*IDENT/i.test(linha));
      if (idxDoc >= 0) {
        const linhaDoc = linhas[idxDoc].replace(/^.*DOC\.?\s*IDENTIDADE[^:]*[:\s]*/i, "").trim();
        if (linhaDoc && linhaDoc.length >= 5) {
          docIdentidade = linhaDoc;
        } else {
          const proximaLinha = linhas[idxDoc + 1] || "";
          if (/^[A-Z0-9.\-\/ ]{5,}$/i.test(proximaLinha)) docIdentidade = proximaLinha;
        }
      }
    }

    let localEmissaoCnh = extrairComRegex([
      /\bLOCAL\b[:\s]*([A-ZÀ-Ú0-9,\-\.\/ ]{3,})/i,
    ]);

    if (!localEmissaoCnh) {
      const idxLocal = linhas.findIndex((linha) => /^LOCAL\b/i.test(linha));
      if (idxLocal >= 0) {
        const linhaLocal = linhas[idxLocal].replace(/^LOCAL[:\s]*/i, "").trim();
        if (linhaLocal && linhaLocal.length >= 3) {
          localEmissaoCnh = linhaLocal;
        } else {
          const proximaLinha = linhas[idxLocal + 1] || "";
          if (/^[A-ZÀ-Ú0-9,\-\.\/ ]{3,}$/i.test(proximaLinha)) localEmissaoCnh = proximaLinha;
        }
      }
    }

    let orgaoEmissor = null;
    let ufEmissor = null;

    if (docIdentidade) {
      const docSemEspaco = docIdentidade.replace(/\s+/g, "");
      const ufMatch = docIdentidade.match(/([A-Z]{2})$/i) || docSemEspaco.match(/([A-Z]{2})$/i);
      if (ufMatch?.[1]) ufEmissor = ufMatch[1].toUpperCase();

      const orgaoComBarra = docIdentidade.match(/(?:\/|-)\s*([A-Z]{2,12})\s*(?:\/|-)\s*[A-Z]{2}$/i);
      if (orgaoComBarra?.[1]) orgaoEmissor = orgaoComBarra[1].toUpperCase();

      if (!orgaoEmissor && ufEmissor && docSemEspaco.length > 4) {
        const letrasFinais = docSemEspaco.match(/([A-Z]{4,})$/i)?.[1] || null;
        if (letrasFinais && letrasFinais.endsWith(ufEmissor) && letrasFinais.length > 2) {
          orgaoEmissor = letrasFinais.slice(0, -2).toUpperCase() || null;
        }
      }
    }

    return {
      cpf: cpf,
      cnh: cnh,
      nome: limparCampo(nome),
      dataNascimento,
      dataPrimeiraHabilitacao,
      validadeCnh,
      categoriaCnh: categoriaCnh || null,
      docIdentidade: limparCampo(docIdentidade),
      orgaoEmissor: limparCampo(orgaoEmissor),
      ufEmissor: limparCampo(ufEmissor),
      dataEmissaoCnh,
      localEmissaoCnh: limparCampo(localEmissaoCnh),
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

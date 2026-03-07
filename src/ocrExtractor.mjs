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
                  type: 'DOCUMENT_TEXT_DETECTION'
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
    const normalizarComparacao = (valor) =>
      String(valor || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
    const linhasNormalizadas = linhas.map((linha) => normalizarComparacao(linha));

    const limparCampo = (valor) => {
      const textoValor = String(valor || "").replace(/\s+/g, " ").trim();
      return textoValor || null;
    };

    const normalizarNumeroPossivel = (valor = "") =>
      String(valor || "")
        .replace(/[OoQ]/g, "0")
        .replace(/[Il|]/g, "1")
        .replace(/[Ss]/g, "5");

    const normalizarData = (valor) => {
      const textoData = String(valor || '').trim();
      if (!textoData) return null;
      const digits = textoData.replace(/\D/g, '');
      if (digits.length !== 8) return null;
      return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    };

    const extrairDataDaLinha = (linha) => {
      const textoLinha = String(linha || "");
      const match = textoLinha.match(
        /(\d{2}[\/\-. ]\d{2}[\/\-. ]\d{4}|\b\d{8}\b|\b\d{2}\s+\d{2}\s+\d{4}\b)/
      );
      return match?.[1] ? normalizarData(match[1]) : null;
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
      // Busca no texto inteiro (rótulo e data próximos)
      for (const rotuloRegex of rotulos) {
        const regex = new RegExp(
          `${rotuloRegex.source}[\\s\\S]{0,80}?(\\d{2}[\\/\\-. ]\\d{2}[\\/\\-. ]\\d{4}|\\b\\d{8}\\b|\\b\\d{2}\\s+\\d{2}\\s+\\d{4}\\b)`,
          "i"
        );
        const match = textoSeguro.match(regex);
        if (match?.[1]) return normalizarData(match[1]);
      }
      // Busca por linha e nas linhas seguintes (OCR costuma quebrar os campos)
      for (let i = 0; i < linhasNormalizadas.length; i++) {
        const linhaOriginal = linhas[i];
        const bateRotulo = rotulos.some((rotuloRegex) => rotuloRegex.test(linhaOriginal));
        if (!bateRotulo) continue;

        const dataNaLinha = extrairDataDaLinha(linhaOriginal);
        if (dataNaLinha) return dataNaLinha;

        for (let offset = 1; offset <= 3; offset++) {
          const proxLinha = linhas[i + offset];
          const dataProxima = extrairDataDaLinha(proxLinha);
          if (dataProxima) return dataProxima;
        }
      }
      return null;
    };

    const extrairNomeAntesDoCpf = () => {
      const match = textoSeguro.match(
        /([A-ZÀ-Ú][A-ZÀ-Ú'´`^~\- ]{8,}?)\s+\d{3}\.?\d{3}\.?\d{3}-?\d{2}/i
      );
      const candidato = limparCampo(match?.[1] || "");
      return nomeEhValido(candidato) ? candidato : null;
    };

    const nomePareceCabecalho = (valor) => {
      const nomeNorm = normalizarComparacao(valor);
      if (!nomeNorm) return true;
      return [
        /REPUBLICA FEDERATIVA/,
        /MINISTERIO/,
        /SECRETARIA NACIONAL/,
        /SENATRAN/,
        /INFRAESTRUTURA/,
        /CIDADES/,
        /DEPARTAMENTO NACIONAL/,
        /CARTEIRA NACIONAL/,
        /DE TRANSITO/,
        /^NOME$/,
        /DOC IDENTIDADE/,
        /ORGAO EMISSOR/,
        /FILIACAO/,
        /VALIDADE/,
        /REGISTRO/,
        /LOCAL E UF DE NASCIMENTO/,
        /PRIMEIRA HABILITACAO/,
      ].some((regex) => regex.test(nomeNorm));
    };

    const nomePlaceholder = (valor) => {
      const nomeNorm = normalizarComparacao(valor);
      if (!nomeNorm) return true;
      return [
        /^E SOBRENOME$/,
        /^NOME E SOBRENOME$/,
        /^SEU NOME$/,
        /^DIGITE SEU NOME$/,
        /^NOME COMPLETO$/,
        /^NAO IDENTIFICADO$/,
        /^DESCONHECIDO$/,
      ].some((regex) => regex.test(nomeNorm));
    };

    const nomeEhValido = (valor) => {
      const nomeLimpo = limparCampo(valor);
      if (!nomeLimpo) return false;
      if (nomePareceCabecalho(nomeLimpo)) return false;
      if (nomePlaceholder(nomeLimpo)) return false;
      return /^[A-ZÀ-Ú][A-ZÀ-Ú'´`^~\- ]{5,}$/i.test(nomeLimpo) && nomeLimpo.split(/\s+/).length >= 2;
    };

    const extrairNomePorLinhas = () => {
      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        const linhaNorm = linhasNormalizadas[i];
        if (!/\bNOME\b/.test(linhaNorm)) continue;

        const candidatoMesmaLinha = limparCampo(linha.replace(/^.*\bNOME\b[:\s-]*/i, ""));
        if (nomeEhValido(candidatoMesmaLinha)) return candidatoMesmaLinha;

        for (let offset = 1; offset <= 3; offset++) {
          const candidato = linhas[i + offset];
          if (nomeEhValido(candidato)) return limparCampo(candidato);
        }
      }

      const idxCpf = linhasNormalizadas.findIndex((linhaNorm) => /\bCPF\b/.test(linhaNorm));
      if (idxCpf > 0) {
        for (let i = idxCpf - 1; i >= Math.max(0, idxCpf - 4); i--) {
          if (nomeEhValido(linhas[i])) return limparCampo(linhas[i]);
        }
      }

      return null;
    };

    // Extrair CPF (padrão: XXX.XXX.XXX-XX ou XXXXXXXXXXX)
    const cpfMatch = textoSeguro.match(/(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/);
    const cpf = cpfMatch ? this.normalizarCPF(cpfMatch[1]) : null;

    // Extrair CNH - múltiplas estratégias
    let cnh = null;
    
    // Estratégia 1: Procura "Registro" ou "CNH" seguido de números
    const cnhMatch1 = textoSeguro.match(
      /(?:N[°ºo]?\s*Registro|Registro|N[°ºo]?\s*CNH|CNH|Numero\s*CNH|N[°ºo]?\s*DO\s*REGISTRO)[:\s-]*([0-9A-Z.\s-]{8,24})/i
    );
    if (cnhMatch1) {
      const digits = normalizarNumeroPossivel(cnhMatch1[1]).replace(/\D/g, "");
      if (digits.length >= 9 && digits.length <= 12) cnh = digits;
    }
    
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

    // Estratégia 4: linha contendo rótulo de registro + valor na linha seguinte
    if (!cnh) {
      const idxRegistro = linhasNormalizadas.findIndex((l) =>
        /(N.*REGISTRO|REGISTRO|NUMERO CNH|N.*CNH)/.test(l)
      );
      if (idxRegistro >= 0) {
        for (let i = idxRegistro; i <= Math.min(linhas.length - 1, idxRegistro + 3); i++) {
          const digits = normalizarNumeroPossivel(linhas[i]).replace(/\D/g, "");
          if (digits.length >= 9 && digits.length <= 12 && digits !== cpf) {
            cnh = digits;
            break;
          }
        }
      }
    }

    // Extrair nome (CNH antiga e nova)
    let nome = extrairNomePorLinhas();
    if (!nome) nome = extrairNomeAntesDoCpf();
    if (!nome) {
      const nomeRegex = extrairComRegex([
        /\bNOME\b[:\s]*([A-ZÀ-Ú][A-ZÀ-Ú'\- ]{4,}?)(?=\s{2,}|DOC\.?\s*IDENT|CPF|DATA\s*NASC|FILIA|PERMISSAO|VALIDADE|CAT\.?\s*HAB|N[°ºo]?\s*REGISTRO|$)/i,
      ]);
      nome = nomeEhValido(nomeRegex) ? nomeRegex : null;
    }

    if (!nome) {
      const idxNome = linhas.findIndex((linha) => /^NOME\b/i.test(linha));
      if (idxNome >= 0) {
        const linhaNome = linhas[idxNome].replace(/^NOME[:\s]*/i, "").trim();
        if (nomeEhValido(linhaNome) && !/^(DOC|CPF|DATA|FILIA|REGISTRO|N[°ºo])/i.test(linhaNome)) {
          nome = linhaNome;
        } else {
          const proximaLinha = linhas[idxNome + 1] || "";
          if (nomeEhValido(proximaLinha)) nome = proximaLinha;
        }
      }
    }

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
      /DOC\.?\s*IDENTIDADE(?:\s*\/\s*ORG\.?\s*EMISSOR(?:\s*\/\s*UF)?)?[:\s-]*([A-Z0-9.\-\/ ]{5,})/i,
      /DOC\.?\s*IDENT(?:\s*\/\s*ORG\.?\s*EMISSOR(?:\s*\/\s*UF)?)?[:\s-]*([A-Z0-9.\-\/ ]{5,})/i,
    ]);

    if (!docIdentidade) {
      const idxDoc = linhas.findIndex((linha) => /DOC\.?\s*IDENT/i.test(linha));
      if (idxDoc >= 0) {
        const linhaDoc = linhas[idxDoc];
        const matchLinhaDoc = linhaDoc.match(
          /DOC\.?\s*IDENT(?:IDADE)?(?:\s*\/\s*ORG\.?\s*EMISSOR(?:\s*\/\s*UF)?)?[:\s-]*([A-Z0-9.\-\/ ]{5,})/i
        );
        const valorMesmaLinha = limparCampo(matchLinhaDoc?.[1] || "");
        if (valorMesmaLinha && /\d/.test(valorMesmaLinha)) {
          docIdentidade = valorMesmaLinha;
        } else {
          const proximaLinha = linhas[idxDoc + 1] || "";
          if (/^[A-Z0-9.\-\/ ]{5,}$/i.test(proximaLinha) && /\d/.test(proximaLinha)) docIdentidade = proximaLinha;
        }
      }
    }

    if (docIdentidade) {
      const docNorm = normalizarComparacao(docIdentidade);
      if (/LOCAL|NASCIMENTO|FILIACAO|VALIDADE|REGISTRO|ASSINATURA/.test(docNorm)) {
        docIdentidade = null;
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
    if (localEmissaoCnh) {
      localEmissaoCnh = localEmissaoCnh.replace(/\bDATA\s+EMISS[ÃA]O.*$/i, "").trim();
      if (/^(E\s+)?UF\s+DE\s+NASCIMENTO$/i.test(localEmissaoCnh) || /LOCAL\s+E\s+UF\s+DE\s+NASCIMENTO/i.test(localEmissaoCnh)) {
        localEmissaoCnh = null;
      }
    }

    const todasDatas = Array.from(
      new Set(
        (textoSeguro.match(/\d{2}[\/\-. ]\d{2}[\/\-. ]\d{4}|\b\d{8}\b|\b\d{2}\s+\d{2}\s+\d{4}\b/g) || [])
          .map(normalizarData)
          .filter(Boolean)
      )
    );

    const parseDate = (s) => {
      const [d, m, y] = String(s || "").split("/");
      if (!d || !m || !y) return null;
      const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
      return Number.isNaN(dt.getTime()) ? null : dt;
    };

    const guessNascimento = () => {
      const now = new Date();
      const min = new Date(now.getUTCFullYear() - 100, now.getUTCMonth(), now.getUTCDate());
      const max = new Date(now.getUTCFullYear() - 16, now.getUTCMonth(), now.getUTCDate());
      const candidatas = todasDatas
        .map((d) => ({ d, dt: parseDate(d) }))
        .filter((x) => x.dt && x.dt >= min && x.dt <= max)
        .sort((a, b) => a.dt - b.dt);
      return candidatas[0]?.d || null;
    };

    const guessPrimeiraHab = (nasc, validade) => {
      const nascDt = parseDate(nasc);
      const validadeDt = parseDate(validade);
      const now = new Date();
      const candidatas = todasDatas
        .map((d) => ({ d, dt: parseDate(d) }))
        .filter((x) => x.dt && x.dt <= now)
        .sort((a, b) => a.dt - b.dt);
      for (const c of candidatas) {
        if (!nascDt && !validadeDt) return c.d;
        if (nascDt && c.dt < nascDt) continue;
        if (validadeDt && c.dt > validadeDt) continue;
        if (!nascDt) return c.d;
        const idade = c.dt.getUTCFullYear() - nascDt.getUTCFullYear();
        if (idade >= 14) return c.d;
      }
      return null;
    };

    const guessValidade = () => {
      const candidatas = todasDatas
        .map((d) => ({ d, dt: parseDate(d) }))
        .filter((x) => x.dt)
        .sort((a, b) => b.dt - a.dt);
      return candidatas[0]?.d || null;
    };

    let dadosNascimentoFallback = null;
    // Fallback de datas: OCR às vezes junta os dígitos sem separador.
    if (!dataNascimento) {
      const idxCpf = linhasNormalizadas.findIndex((linhaNorm) => /\bCPF\b/.test(linhaNorm));
      if (idxCpf >= 0) {
        for (let i = idxCpf; i <= Math.min(linhas.length - 1, idxCpf + 4); i++) {
          const dataLinha = extrairDataDaLinha(linhas[i]);
          if (dataLinha) {
            dadosNascimentoFallback = dataLinha;
            break;
          }
        }
      }
    }

    if (!dataNascimento) {
      const idxNasc = linhasNormalizadas.findIndex((linhaNorm) => /NASCIMENTO/.test(linhaNorm));
      if (idxNasc >= 0) {
        for (let i = idxNasc; i <= Math.min(linhas.length - 1, idxNasc + 3); i++) {
          const dataLinha = extrairDataDaLinha(linhas[i]);
          if (dataLinha) {
            dadosNascimentoFallback = dataLinha;
            break;
          }
        }
      }
    }

    const dataNascimentoFinal = dataNascimento || dadosNascimentoFallback;
    let dataNascimentoComFallback = dataNascimentoFinal || guessNascimento();

    let dataPrimeiraHabilitacaoFinal = dataPrimeiraHabilitacao;
    if (!dataPrimeiraHabilitacaoFinal) {
      const idxPrimeiraHab = linhasNormalizadas.findIndex((linhaNorm) => /(1\s*A?\s*HABILITA|PRIMEIRA\s+HABILITA)/.test(linhaNorm));
      if (idxPrimeiraHab >= 0) {
        for (let i = idxPrimeiraHab; i <= Math.min(linhas.length - 1, idxPrimeiraHab + 3); i++) {
          const dataLinha = extrairDataDaLinha(linhas[i]);
          if (dataLinha) {
            dataPrimeiraHabilitacaoFinal = dataLinha;
            break;
          }
        }
      }
    }
    let validadeCnhFinal = validadeCnh;
    if (!validadeCnhFinal) {
      const idxValidade = linhasNormalizadas.findIndex((linhaNorm) => /VALIDADE/.test(linhaNorm));
      if (idxValidade >= 0) {
        for (let i = idxValidade; i <= Math.min(linhas.length - 1, idxValidade + 2); i++) {
          const dataLinha = extrairDataDaLinha(linhas[i]);
          if (dataLinha) {
            validadeCnhFinal = dataLinha;
            break;
          }
        }
      }
    }
    if (!validadeCnhFinal) {
      validadeCnhFinal = guessValidade();
    }

    if (!dataPrimeiraHabilitacaoFinal) {
      dataPrimeiraHabilitacaoFinal = guessPrimeiraHab(dataNascimentoComFallback, validadeCnhFinal);
    }

    const ordenarDatas = (lista = []) =>
      lista
        .map((d) => ({ d, dt: parseDate(d) }))
        .filter((x) => x.dt)
        .sort((a, b) => a.dt - b.dt);

    const datasOrdenadas = ordenarDatas(todasDatas);

    // Reforço de consistência:
    // 1) Nascimento deve ser a mais antiga.
    // 2) 1ª habilitação deve ficar entre nascimento e validade.
    // 3) Validade deve ser a mais recente.
    if (!dataNascimentoComFallback && datasOrdenadas.length) {
      dataNascimentoComFallback = datasOrdenadas[0].d;
    }
    if (!validadeCnhFinal && datasOrdenadas.length) {
      validadeCnhFinal = datasOrdenadas[datasOrdenadas.length - 1].d;
    }

    let nascDt = parseDate(dataNascimentoComFallback);
    let validadeDt = parseDate(validadeCnhFinal);

    if (nascDt && validadeDt && nascDt > validadeDt) {
      const temp = dataNascimentoComFallback;
      dataNascimentoComFallback = validadeCnhFinal;
      validadeCnhFinal = temp;
      nascDt = parseDate(dataNascimentoComFallback);
      validadeDt = parseDate(validadeCnhFinal);
    }

    const datasNoIntervalo = datasOrdenadas.filter((x) => {
      if (nascDt && x.dt < nascDt) return false;
      if (validadeDt && x.dt > validadeDt) return false;
      return true;
    });

    const datasIntermediarias = datasNoIntervalo.filter(
      (x) => x.d !== dataNascimentoComFallback && x.d !== validadeCnhFinal
    );

    let primeiraHabDt = parseDate(dataPrimeiraHabilitacaoFinal);
    const primeiraHabForaDeIntervalo =
      (primeiraHabDt && nascDt && primeiraHabDt < nascDt) ||
      (primeiraHabDt && validadeDt && primeiraHabDt > validadeDt);

    if (!dataPrimeiraHabilitacaoFinal || primeiraHabForaDeIntervalo) {
      dataPrimeiraHabilitacaoFinal =
        datasIntermediarias[0]?.d ||
        datasNoIntervalo.find((x) => x.d !== dataNascimentoComFallback)?.d ||
        dataPrimeiraHabilitacaoFinal;
      primeiraHabDt = parseDate(dataPrimeiraHabilitacaoFinal);
    }

    if (
      dataPrimeiraHabilitacaoFinal &&
      dataNascimentoComFallback &&
      dataPrimeiraHabilitacaoFinal === dataNascimentoComFallback &&
      datasIntermediarias.length
    ) {
      dataPrimeiraHabilitacaoFinal = datasIntermediarias[0].d;
      primeiraHabDt = parseDate(dataPrimeiraHabilitacaoFinal);
    }

    if (
      dataPrimeiraHabilitacaoFinal &&
      validadeCnhFinal &&
      dataPrimeiraHabilitacaoFinal === validadeCnhFinal &&
      datasIntermediarias.length
    ) {
      dataPrimeiraHabilitacaoFinal = datasIntermediarias[0].d;
      primeiraHabDt = parseDate(dataPrimeiraHabilitacaoFinal);
    }

    if (primeiraHabDt && validadeDt && primeiraHabDt > validadeDt) {
      const melhorPrimeira = datasIntermediarias.find((x) => !validadeDt || x.dt <= validadeDt);
      if (melhorPrimeira?.d) dataPrimeiraHabilitacaoFinal = melhorPrimeira.d;
    }

    let dataEmissaoCnhFinal = dataEmissaoCnh;
    if (!dataEmissaoCnhFinal) {
      const idxEmissao = linhasNormalizadas.findIndex((linhaNorm) => /DATA\s+EMISSAO|EMISSAO/.test(linhaNorm));
      if (idxEmissao >= 0) {
        for (let i = idxEmissao; i <= Math.min(linhas.length - 1, idxEmissao + 2); i++) {
          const dataLinha = extrairDataDaLinha(linhas[i]);
          if (dataLinha) {
            dataEmissaoCnhFinal = dataLinha;
            break;
          }
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
      dataNascimento: dataNascimentoComFallback,
      dataPrimeiraHabilitacao: dataPrimeiraHabilitacaoFinal,
      validadeCnh: validadeCnhFinal,
      categoriaCnh: categoriaCnh || null,
      docIdentidade: limparCampo(docIdentidade),
      orgaoEmissor: limparCampo(orgaoEmissor),
      ufEmissor: limparCampo(ufEmissor),
      dataEmissaoCnh: dataEmissaoCnhFinal,
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

/**
 * certidaoClassifier.js
 * Classifica o texto da certidão do DETRAN
 * Entrada: texto normalizado (UPPERCASE, sem acento)
 * Saída: status objetivo para o diagnóstico
 */

export function classificarCertidao(normalizedText = "") {
  if (!normalizedText) {
    return {
      status: "DESCONHECIDO",
      motivo: "Texto vazio",
      flags: {}
    };
  }

  const flags = {
    nadaConsta: normalizedText.includes("NADA CONSTA"),
    consta: normalizedText.includes("CONSTA"),
    processo: normalizedText.includes("PROCESSO"),
    suspensao: normalizedText.includes("SUSPENSAO"),
    cassacao: normalizedText.includes("CASSACAO")
  };

  let status = "DESCONHECIDO";
  let motivo = "Não foi possível classificar";

  if (flags.nadaConsta) {
    status = "OK";
    motivo = "Certidão Nada Consta";
  } else if (flags.consta || flags.processo || flags.suspensao || flags.cassacao) {
    status = "RESTRICAO";
    motivo = "Certidão com restrição";
  }

  return {
    status,
    motivo,
    flags
  };
}

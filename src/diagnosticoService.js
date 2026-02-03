/**
 * diagnosticoService.js
 * Gera diagnóstico objetivo a partir da certidão e da pontuação (opcional)
 */

export function gerarDiagnostico({ certidao, pontuacao = null }) {
  const diagnostico = {
    certidaoStatus: certidao.status,
    risco: "BAIXO",
    cabeRecurso: false,
    recomendacao: "",
  };

  // Certidão OK
  if (certidao.status === "OK") {
    diagnostico.risco = "BAIXO";
    diagnostico.cabeRecurso = false;
    diagnostico.recomendacao = "CNH regular. Nenhuma ação necessária.";
    return diagnostico;
  }

  // Certidão com restrição
  if (certidao.status === "RESTRICAO") {
    diagnostico.cabeRecurso = true;

    // Avaliação por flags
    if (certidao.flags?.suspensao || certidao.flags?.cassacao) {
      diagnostico.risco = "ALTO";
      diagnostico.recomendacao =
        "Processo grave identificado. Recomendada análise técnica imediata.";
      return diagnostico;
    }

    // Avaliação por pontuação
    if (pontuacao) {
      const pontos = Number(pontuacao.pontos || 0);

      if (pontos >= 20) {
        diagnostico.risco = "ALTO";
        diagnostico.recomendacao =
          "Pontuação crítica. Risco iminente de suspensão. Cabe recurso.";
      } else if (pontos >= 14) {
        diagnostico.risco = "MEDIO";
        diagnostico.recomendacao =
          "Pontuação elevada. Recomendada defesa preventiva.";
      } else {
        diagnostico.risco = "MEDIO";
        diagnostico.recomendacao =
          "Existem multas ativas. Avaliar recurso.";
      }
    } else {
      diagnostico.risco = "MEDIO";
      diagnostico.recomendacao =
        "Restrição identificada. Recomendada consulta de pontuação.";
    }
  }

  return diagnostico;
}

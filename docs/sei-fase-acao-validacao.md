# RPA SEI — Documento de Validação da Fase 2 (Ação Administrativa)

## 1) Objetivo
Definir e validar a **Fase de Ação** do robô no SEI, executada após a triagem (já concluída), **sem tramitação nesta etapa**.

Escopo desta validação:
- Abrir processo no SEI.
- Ler dados da planilha Google (nuvem).
- Avaliar as colunas de decisão.
- Quando aplicável, criar documento do tipo **Despacho para PPP** usando modelo informado.
- Salvar documento com data do dia.

Fora de escopo nesta fase:
- Tramitação do processo.
- Assinatura eletrônica.
- Regras adicionais de outras classificações/ações não descritas aqui.

---

## 2) Regra de Negócio Validada
Executar ação **somente** quando:
- `classificação = RETORNO/TRAMITAÇÃO`
- `ação_adm = Criar despacho para PPP`

Ação esperada no SEI:
1. Entrar no processo.
2. Clicar em **Incluir Documento**.
3. Selecionar tipo **Despacho**.
4. Preencher campos com valores padrão.
5. Abrir documento gerado em pop-up.
6. Alterar apenas a data para a data atual.
7. Salvar.

---

## 3) Mapeamento de Campos (SEI)
### Tela “Incluir Documento > Despacho”
- **Título**: manter padrão “Despacho”.
- **Texto inicial**: selecionar `Documento Modelo`.
  - No campo de busca livre do modelo, informar: `1766545`.
- **Descrição**: `IMPLANTAÇÃO`.
- **Nome na Árvore**: `DTP`.
- **Nível de Acesso**: `Público`.
- Demais campos não mapeados nesta fase: manter padrão do sistema/unidade.

### Pop-up do documento
- Alterar **somente** a data para `data de hoje`.
- Acionar **Salvar**.

---

## 4) Fluxo Operacional (alto nível)
1. Receber item de trabalho da triagem (com identificação do processo e dados da planilha).
2. Abrir processo no SEI.
3. Ler colunas da planilha:
   - `classificação`
   - `ação_adm`
4. Avaliar gatilho da regra de negócio.
5. Se regra casar, executar criação de despacho conforme seção 3.
6. Registrar resultado da execução (sucesso/erro + evidências).

---

## 5) Pseudofluxo para Implementação
```text
para cada processo_da_triagem:
  abrir_processo_no_sei(processo_da_triagem.id)

  classificacao = planilha["classificação"]
  acao_adm = planilha["ação_adm"]

  se classificacao == "RETORNO/TRAMITAÇÃO" e acao_adm == "Criar despacho para PPP":
      clicar("Incluir Documento")
      selecionar_tipo_documento("Despacho")

      set_texto_inicial_documento_modelo("1766545")
      set_descricao("IMPLANTAÇÃO")
      set_nome_arvore("DTP")
      set_nivel_acesso("Público")

      confirmar_inclusao_documento()

      alternar_para_popup_documento()
      set_data_hoje()
      clicar_salvar()

      registrar_status("SUCESSO_FASE_ACAO", processo)
  senão:
      registrar_status("SEM_ACAO_NA_FASE", processo)
```

---

## 6) Padrões de Robustez Recomendados (boas práticas)
1. **Esperas explícitas por estado da tela**
   - Aguardar botão/iframe/pop-up visível e habilitado antes de clicar.
2. **Seletores resilientes**
   - Priorizar atributos estáveis (`id`, `name`, texto de rótulo único).
3. **Timeouts com política única**
   - Ex.: curto (5s), médio (15s), longo (45s), padronizados.
4. **Idempotência funcional**
   - Antes de incluir novo despacho, verificar se já existe documento “DTP” do dia (opcional nesta fase, recomendado para próxima iteração).
5. **Tratamento de pop-up**
   - Capturar evento de nova aba/janela de forma controlada.
6. **Rastreabilidade**
   - Log por processo com: timestamp, número SEI, decisão de regra, ação executada, erro detalhado.
7. **Evidência operacional**
   - Salvar screenshot em caso de erro e, opcionalmente, screenshot de sucesso após salvar.

---

## 7) Critérios de Aceite (Validação Funcional)
### Cenário A — Deve executar
Dado:
- `classificação = RETORNO/TRAMITAÇÃO`
- `ação_adm = Criar despacho para PPP`

Então:
- O robô cria documento do tipo **Despacho**.
- Usa modelo `1766545` em `Texto inicial > Documento Modelo`.
- Preenche descrição `IMPLANTAÇÃO`.
- Define `Nome na Árvore = DTP`.
- Define `Nível de Acesso = Público`.
- Abre pop-up, altera data para hoje e salva.
- Registra status de sucesso.

### Cenário B — Não deve executar
Dado qualquer combinação fora da regra acima:
- O robô não cria despacho nesta fase.
- Registra status “sem ação na fase”.

---

## 8) Matriz de Decisão (Fase atual)
| classificação         | ação_adm                    | Ação do robô nesta fase |
|----------------------|-----------------------------|-------------------------|
| RETORNO/TRAMITAÇÃO   | Criar despacho para PPP     | Criar despacho (fluxo completo) |
| qualquer outro valor | qualquer outro valor        | Não executar ação nesta fase |

---

## 9) Pontos para Confirmação antes da implementação final
1. Nome exato dos cabeçalhos na planilha (acentos, maiúsculas/minúsculas).
2. Há variação do texto do botão “Incluir Documento” por perfil/unidade?
3. O modelo `1766545` é sempre acessível por favoritos/campo livre para o usuário do robô?
4. Há máscara/formato específico para a data no pop-up?
5. Necessidade de validar existência prévia de despacho no processo (evitar duplicidade)?

---

## 10) Resultado esperado desta validação
Com este documento aprovado, a próxima etapa é implementar a automação da **Fase de Ação** exatamente conforme regras acima e, em seguida, evoluir para a fase de **Tramitação**.

## 11) Referência de Implementação (Playwright)
- Foi adicionada uma referência executável em `scripts/sei_despacho_ppp.py` com foco no problema relatado de navegação após **Incluir Documento > Despacho**.
- Para aderir à estrutura operacional, foi criado também o entrypoint `scripts/acao.py`, que executa a fase de ação reutilizando o fluxo robusto do despacho PPP.
- Pontos-chave da implementação:
  - Busca resiliente do botão **Incluir Documento** em múltiplos frames.
  - Redescoberta dinâmica do frame de trabalho (incluindo fallback por URL/seletores quando `ifrVisualizacao` variar).
  - Espera explícita da troca de tela para o formulário do Despacho.
  - Seleção de **Documento Modelo** com fallback para variações de seletor (incluindo `#optProtocoloDocumentoTextoBase`).
  - Salvamento com captura do pop-up do editor e atualização da data via CKEditor.
  - Compatibilidade de estrutura local: pode rodar como `python scripts/acao.py` (neste repositório) ou `python src/acao.py` (estrutura no Mac), com busca flexível do `credentials.json` e opção `GOOGLE_CREDENTIALS_FILE` no `.env`.

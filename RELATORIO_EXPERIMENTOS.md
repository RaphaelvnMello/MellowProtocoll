# MellowProtocol — Relatório de Experimentos

> Consolidação dos 4 critérios de sucesso (Seção "Fase D" do roteiro). Este relatório acompanha o Capítulo 4 da dissertação; quando houver divergência, o capítulo e o código desta revisão prevalecem sobre versões anteriores deste arquivo.

Execução original: 2026-08-23 (coleta de `P_gas`). Revisões 1 a 3: 2026-10-09. Stack: Solidity 0.8.20 (`viaIR: true`, `optimizer runs: 200`), Hardhat 2.29.1, OpenZeppelin Contracts 5.6.1, Slither 0.11.6.

---

## 0. Histórico de correções

### Revisão 1

1. **Cobertura da matriz δ confundida com cobertura de código.** A versão original declarava o critério 2 satisfeito com 100% de `solidity-coverage`. Essa métrica mede linhas e ramos, não as 64 células da matriz δ (8 estados × 8 σ). A suíte original exercitava as 12 transições definidas, mas apenas 23 das 52 células ∅ (35/64). Corrigido com [test/matrizEstados.test.ts](test/matrizEstados.test.ts), que gera as 52 verificações a partir da declaração da matriz. `accessControl.test.ts` passou a cobrir apenas o controle de acesso por ator.
2. **Ordenação dos prazos não verificada.** O construtor passou a exigir `τ_aceite < τ_financ < τ_exec` (erro `PrazosInvalidos`), com testes em [dispute.test.ts](test/dispute.test.ts).

### Revisão 2

3. **Gás de σ8 e do ciclo com disputa calculados por média.** O `hardhat-gas-reporter` relatava 75 361 para `executarDecisao`, média de decisões integrais (1 transferência) e parciais (2 transferências), e o ciclo de 380 069 era uma soma de médias. A medição passou a ser por recibo ([scripts/medirGasReal.ts](scripts/medirGasReal.ts)).
4. **Implantação fora do custo.** Cada acordo exige uma implantação própria; a leitura conservadora do critério 3 soma implantação e ciclo.
5. **Faixa de implantação e custo de clone estimados.** Substituídos por medições, com a variante experimental [MellowProtocolClonable.sol](contracts/experimental/MellowProtocolClonable.sol) e a fábrica [MellowProtocolCloneFactory.sol](contracts/experimental/MellowProtocolCloneFactory.sol).

### Revisão 3

6. **Chave da API exposta.** A chave da Owlracle estava gravada em `gas.py`. O script passou a lê-la de `OWLRACLE_API_KEY`. A chave antiga permanece no histórico do git e deve ser revogada no painel da Owlracle.
7. **`P_gas` com duas metodologias.** A versão anterior deste relatório afirmava não haver acesso a dados históricos e tratava 376 Gwei como pico pontual, enquanto `gas.py` calcula a mediana real de 30 dias (374,86 Gwei em 23/08/2026), que é o valor adotado na dissertação. A Seção 3.2 passa a usar apenas a mediana.
8. **Câmbio sem fonte e em data sem cotação oficial.** A coleta de 23/08/2026 caiu em um domingo, sem PTAX. Adota-se a PTAX de venda de 21/08/2026 (último dia útil anterior), R$ 5,1625 (R$ 5,1619 é a taxa de compra do mesmo dia).
9. **Variante clonável validada apenas parcialmente.** Acrescentado [test/experimental/clonableConformidade.test.ts](test/experimental/clonableConformidade.test.ts), que aplica ao clone a mesma verificação do contrato principal (68 testes). Cobertura de código de 100% também em `MellowProtocolClonable.sol` e `MellowProtocolCloneFactory.sol`.
10. **Inconsistências internas deste relatório.** Contagem do Slither (12 → 7 → 8), gás de σ6 (75 637, e não a média 75 647), referências a números de linha (substituídas por nomes de função) e menção a "~91% citados na dissertação" (valor que não consta dos capítulos) corrigidas.

11. **Custo incompleto e evidências curtas.** O `approve` obrigatório antes de σ2 (45 945) não era medido, e as evidências de σ4 e σ6 eram identificadores curtos. Com CIDv1 de 59 caracteres, o ciclo com disputa sobe para 481 728. Ambos passaram a constar de `scripts/medirGasReal.ts`.

**Correção de σ2 (out. 2026).** `financiar` passou a gravar o estado antes da transferência e a usar `nonReentrant`, no contrato principal e no clone. Um teste com token que aciona o remetente durante `transferFrom` (`MaliciousERC20`, gatilho no remetente) mostrava que, na versão anterior, uma chamada de σ7 após τ_financ levava o contrato a CANCELADO no meio do depósito, estado sobrescrito por FINANCIADO, com emissão de `ContratoCancelado`. Com a correção, a reentrada é bloqueada. Todas as medições abaixo referem-se à versão corrigida (σ2 passou de 58 265 para 60 575 de gás; as funções com `nonReentrant` subiram 66 de gás cada; a implantação caiu para 1 606 196).

**Teste de propriedade de S1 (out. 2026).** Acrescentado [test/fuzzS1.test.ts](test/fuzzS1.test.ts), descrito na Seção 1.1.

Estado atual: **175 testes passando**, cobertura de 100% em todos os eixos nos três contratos do protocolo, Slither sem alertas Alta/Média (8 achados Baixa/Informacional).

---

## 1. Propriedades formais (S1, S2, L1) — verificação por inspeção

### S1 — Integridade do saldo

O único caminho que credita o contrato, `financiar`, verifica o diferencial de saldo (`saldoDepois - saldoAntes == v`) e reverte com `DepositoInvalido` se o crédito for menor que `v`. Exercitado com `FeeOnTransferERC20` (taxa de 1%) no contrato principal e no clone.

Os caminhos que debitam o contrato transferem exatamente o saldo custodiado: `aprovarPagamento` e `acionarWatchdog` em ENTREGUE liberam `v` a αp; `executarDecisao(valor)` libera `valor` a αp e `v - valor` a αc. Em todos, o saldo final é 0. O estado é atualizado e o evento emitido antes de `safeTransfer`.

Premissas de instanciação: o construtor (e a fábrica, no clone) impõe `τ_aceite < τ_financ < τ_exec`. As condições `t0 < τ_aceite` e `Δt_insp > 0` **não** são verificadas em código; são premissas declaradas no Capítulo 3 (ver Seção 6).

### 1.1 S1 por teste de propriedade (*fuzzing* com semente fixa)

`test/fuzzS1.test.ts` executa sequências aleatórias de chamadas sobre implantações novas, sem ferramentas além do Hardhat. Configuração padrão: semente 20261009, 300 campanhas de 20 passos (6 000 passos).

**Como os passos são sorteados:**
- Cada passo é uma das oito funções de Σ, chamada por αc, αp, αa ou um terceiro, ou então uma transferência direta do terceiro ao contrato (componente D).
- Metade dos passos é guiada para eventos habilitados, para alcançar os estados profundos.
- O relógio é posicionado com `setNextBlockTimestamp`, com preferência por τ − 1, τ e τ + 1 do prazo do estado corrente.

**Modelo de referência.** É escrito a partir da tabela de transição e do quadro de *watchdogs* do Capítulo 3, e não a partir do código. Ele prevê, a cada passo, a aceitação ou a reversão, o estado seguinte e os efeitos e_in e e_out.

**O que se verifica após cada passo:**
1. A aceitação ou reversão observada é igual à prevista (δ e guardas).
2. O estado no contrato é igual ao estado do modelo.
3. B(ρ) = 𝓕(s) (S1).
4. Saldo real = B(ρ) + D.
5. Árbitro e terceiro não recebem valor; a soma dos saldos se conserva; σ5, σ7 (Δt4) e σ8 creditam exatamente v, `valor` e v − `valor` aos destinatários.

**Resultado com a semente padrão:**
- 6 000 passos: 934 transições aceitas, 4 578 chamadas revertidas e 488 transferências diretas.
- As 12 transições definidas foram exercitadas, de 5 (ENTREGUE, σ7) a 215 (CRIADO, σ1) vezes.
- Nenhuma divergência.

**Sensibilidade (mutação manual, sem patches versionados).** Quatro alterações deliberadas no contrato foram todas detectadas:
- guarda de Δt4 com `<` em vez de `<=`;
- repartição de σ8 com perda de uma unidade;
- σ6 aceita em EM_EXECUCAO;
- guarda de Δt3 antecipada em 1 s.

O contrato foi restaurado após cada mutação.

**Alcance.** É verificação por amostragem, não prova. A garantia de S1 continua sendo a demonstração por indução do Capítulo 3. O teste mostra que a implementação concorda com o modelo nas trajetórias sorteadas, inclusive com transferências diretas e nas fronteiras dos prazos.

### 1.2 Modelo temporizado para o UPPAAL e exploração discreta

`modelo/mellow_uppaal.xml` transcreve M_τ para o UPPAAL, com as consultas de S1, S2 e L1. As premissas H1 e H2 entram como invariantes de localização.

**Execução no UPPAAL: verificado.** `verifyta modelo/mellow_uppaal.xml` (UPPAAL 5.0.0, licença acadêmica, 10/10/2026) declara satisfeitas as 10 consultas: S1 (duas), S2, cancelamento sem movimentação de valor, L1, L1 com horizonte T_max, ausência de bloqueio e três de alcançabilidade. O espaço simbólico tem 18 estados (zonas), e a verificação leva menos de 0,1 s. Saída completa em `modelo/verifyta_saida.txt`.

**Sensibilidade no UPPAAL.** Com T_max reduzido em uma unidade, apenas a consulta de L1 com horizonte deixa de ser satisfeita, e as outras nove continuam satisfeitas. Isso confirma no verificador que o horizonte é justo, como na exploração discreta abaixo.

**Exploração discreta.** `modelo/explorar_discreto.py` explora o mesmo modelo em tempo discreto, com passo de 1/2:
- 102 199 estados, sem violação de S1, S2, do horizonte T_max ou de ausência de bloqueio;
- o horizonte é justo: EM_DISPUTA é alcançável com x0 = T_max;
- com T_max − 1 (`python3 modelo/explorar_discreto.py -1`), o script acusa violação.

O script reimplementa em Python o autômato do XML; não lê o arquivo.

### 1.3 Rede de teste Amoy

`scripts/cicloAmoy.ts` executa um ciclo nominal e um ciclo com disputa na Polygon Amoy e registra o gás e o preço efetivo de cada transação.

**Execução: não feita.** O ambiente da revisão não tem acesso à rede. O script requer `AMOY_RPC_URL` e três chaves com POL de teste.

### S2 — Restrição e unicidade da liquidação

Nenhuma função de saída aceita endereço de destino como parâmetro; os únicos destinatários são `contratante` e `prestador`, fixados na criação. Como CONCLUIDO é absorvente, a liquidação não se repete.

### L1 — Vivacidade condicional

De cada estado não absorvente há ao menos uma transição habilitada:

| Estado | Transições disponíveis |
|---|---|
| CRIADO | σ1 ou σ7 (Δt1) |
| ACEITO | σ2 ou σ7 (Δt2) |
| FINANCIADO | σ3 ou σ7 (Δt3) |
| EM_EXECUCAO | σ4 ou σ7 (Δt3) |
| ENTREGUE | σ5, σ6 ou σ7 (Δt4) |
| EM_DISPUTA | σ8 apenas |

Nenhum *watchdog* é definido para EM_DISPUTA, cuja única saída é σ8, acionada pelo módulo de arbitragem. L1 é, portanto, condicional a duas premissas (Capítulo 3): o árbitro responde em tempo finito e σ7 é acionado após cada prazo. A implementação é fiel à matriz δ e não introduz saída adicional.

---

## 2. Cobertura

### 2.1 Suíte de testes

| Arquivo | Testes | Finalidade |
|---|---:|---|
| `nominal.test.ts` | 7 | Caminho nominal CRIADO → CONCLUIDO |
| `matrizEstados.test.ts` | 53 | 52 células ∅ + meta-verificação 12/52/64 |
| `accessControl.test.ts` | 10 | Controle de acesso por ator |
| `watchdog.test.ts` | 13 | Δt1 a Δt4 |
| `reentrancy.test.ts` | 5 | `nonReentrant` em σ5, σ7 e σ8 e em σ2 (gancho do remetente) |
| `dispute.test.ts` | 13 | σ6, σ8, depósito incompleto, construtor e prazos |
| `fuzzS1.test.ts` | 1 | Teste de propriedade de S1: 300 campanhas × 20 passos contra modelo de referência (Seção 1.1) |
| `experimental/clonable.test.ts` | 3 | Ciclo nominal sobre o clone, independência de P, custo de criação |
| `experimental/clonableConformidade.test.ts` | 70 | Matriz δ (53), 12 transições (8), acesso (2), fábrica (1), depósito incompleto e reentrância (4) sobre o clone |
| **Total** | **175** | |

### 2.2 Cobertura de código (`npx hardhat coverage`)

```
File                             |  % Stmts | % Branch |  % Funcs |  % Lines |
MellowProtocol.sol               |      100 |      100 |      100 |      100 |
MellowProtocolClonable.sol       |      100 |      100 |      100 |      100 |
MellowProtocolCloneFactory.sol   |      100 |      100 |      100 |      100 |
```

### 2.3 Cobertura da matriz δ

| | Células | Contrato principal | Clone |
|---|---:|---|---|
| Definidas (δ ≠ ∅) | 12 | 12 (`nominal`, `watchdog`, `dispute`) | 12 (`clonableConformidade`) |
| Indefinidas (δ = ∅) | 52 | 52 (`matrizEstados`) | 52 (`clonableConformidade`) |
| **Total** | **64** | **64** | **64** |

No clone, a guarda de estado é avaliada antes da guarda de ator (que fica no corpo da função); no contrato principal, a ordem é inversa. A matriz é exercida com o ator correto nos dois casos, de modo que a reversão observada é sempre `EstadoInvalido`.

---

## 3. Custo de gás e viabilidade econômica

### 3.1 Gás por função, medido por recibo

Reproduzir: `npx hardhat run scripts/medirGasReal.ts`.

| Função | Contrato principal | Clone |
|---|---:|---:|
| aceitar (σ1) | 44 812 | 49 504 |
| financiar (σ2) | 60 575 | 85 170 |
| iniciarExecucao (σ3) | 27 828 | 32 476 |
| confirmarEntrega (σ4, evidência de 22 caracteres) | 98 156 | 102 944 |
| confirmarEntrega (σ4, CIDv1 de 59 caracteres) | 143 458 | — |
| aprovarPagamento (σ5) | 58 516 | 63 234 |
| abrirDisputa (σ6, evidência de 11 caracteres) | 75 637 | 80 483 |
| abrirDisputa (σ6, CIDv1 de 59 caracteres) | 121 013 | — |
| acionarWatchdog (σ7, Δt4) | 62 046 | — |
| executarDecisao (σ8, decisão parcial) | 84 042 | 71 699 |
| executarDecisao (σ8, decisão integral) | 58 830 a 58 866 | — |
| **Ciclo nominal** | **289 887** | **333 328** |
| **Ciclo com disputa, decisão parcial (pior caso)** | **391 050** | **422 276** |
| Ciclo com disputa, decisão integral | 365 838 a 365 874 | — |
| Ciclo via Δt4 | 293 417 | — |
| Ciclo nominal, evidência CIDv1 | 335 189 | — |
| Ciclo com disputa, evidências CIDv1 (pior caso medido) | 481 728 | — |
| `approve` do token (fora de Σ, prévio a σ2) | 45 945 | 45 945 |

### 3.2 Conversão para BRL

`C_BRL = G × P_gas × 10⁻⁹ × P_POL × P_USD/BRL`, com:

- `P_gas` = **374,86 Gwei**, mediana dos fechamentos diários dos 30 dias anteriores a 23/08/2026, API de histórico da Owlracle (`gas.py`).
- `P_POL` = US$ 0,1091, fechamento diário oficial de 23/08/2026 (candle de 00:00 a 23:59:59 UTC; fechamento US$ 0,10914304) na aba de dados históricos do CoinMarketCap (POL, id 28321), conferido em 10/10/2026. O valor anterior, US$ 0,09, não tinha fonte registrada. A Owlracle não devolve o preço do token.
- `P_USD/BRL` = R$ 5,1625, PTAX de venda de 21/08/2026 (último dia útil antes da coleta), conferida pelo autor no Banco Central em 10/10/2026. O valor anterior, R$ 5,1619, era a taxa de compra.

| Cenário | Gás | Custo | % do teto (R$ 3,00) |
|---|---:|---:|---:|
| Nominal | 289 887 | R$ 0,0612 | 2,04% |
| Via Δt4 | 293 417 | R$ 0,0619 | 2,06% |
| Disputa, pior caso | 391 050 | R$ 0,0826 | 2,75% |
| Nominal, CIDv1 | 335 189 | R$ 0,0708 | 2,36% |
| Disputa, CIDv1 | 481 728 | R$ 0,1017 | 3,39% |
| Implantação + `approve` + nominal, CIDv1 | 1 987 330 | R$ 0,4196 | 13,99% |
| Implantação + `approve` + disputa, CIDv1 | 2 133 869 | R$ 0,4505 | 15,02% |

Preço do gás que levaria cada caso ao teto, mantidas as cotações: ≈ 2 496 Gwei (implantação + `approve` + disputa com CIDv1, 6,7 × a mediana), ≈ 11 057 Gwei (disputa com CIDv1, 29,5 ×), ≈ 18 374 Gwei (nominal com evidência curta, 49 ×). "Ciclo completo" é a sequência de eventos de Σ de CRIADO a um estado absorvente, com uma evidência por chamada de σ4 e σ6; implantação e `approve` ficam fora de Σ e entram na leitura conservadora. O critério 3 é satisfeito nas duas leituras.

### 3.3 Implantação e padrões de clone

| Padrão | Gás de criação | Criação + ciclo com disputa | Custo por acordo |
|---|---:|---:|---:|
| `MellowProtocol` completo (CIDv1 de 59 caracteres) | 1 606 196 | 1 997 246 | R$ 0,4217 |
| `Clones.clone` sem argumentos (não funcional) | 63 797 | — | — |
| `MellowProtocolClonable` via `cloneWithImmutableArgs` | 153 374 | 575 650 | R$ 0,1215 |

A implantação completa cresce em degraus de cerca de 22 400 de gás a cada 32 caracteres de `cidSpec` além de 31 (medido de 11 a 128 caracteres). O clone funcional reduz a criação em 90,5%, mas decodifica P a cada chamada (ciclo nominal +15,0%, ciclo com disputa +8,0%); por acordo, a economia é de 71,2%.

---

## 4. Auditoria estática (Slither 0.11.6)

```
slither . --exclude-dependencies
```

Resultado: **24 contratos analisados, 8 achados, nenhum de severidade Alta ou Média.**

A primeira execução apontou 12 achados. Cinco foram corrigidos: `missing-zero-check` (3, nos mocks, com `DestinoInvalido`), `unindexed-event-address` (1, `DisputaResolvida` com endereços indexados) e `reentrancy-benign` (1, em `MaliciousERC20._update`). Restaram 7; a inclusão dos contratos experimentais acrescentou uma ocorrência de `timestamp`, totalizando 8.

| Severidade | Detector (ocorrências) | Local | Justificativa |
|---|---|---|---|
| Baixa | `timestamp` (2) | `MellowProtocol.acionarWatchdog`, `MellowProtocolClonable.acionarWatchdog` | Mecanismo dos *watchdogs*; manipulação da ordem de segundos frente a prazos de dias. |
| Baixa | `reentrancy-benign` (1) | `ReentrancyExploiter._tentarReentrar` | Grava o resultado da própria tentativa de ataque, lido pelos testes. |
| Informacional | `pragma` (1) | Projeto e dependências OpenZeppelin | Versões distintas entre o projeto (0.8.20 fixo) e as dependências. |
| Informacional | `solc-version` (1) | Todos os `.sol` | Alerta genérico sobre 0.8.20; versão fixada pelo roteiro. |
| Informacional | `low-level-calls` (3) | `MaliciousERC20._update`, `ReentrancyExploiter.executar` e `._tentarReentrar` | Mecanismo do teste de reentrância. |

---

## 5. Critério de sucesso consolidado

| # | Condição | Status |
|---|---|---|
| 1 | S1, S2, L1 verificáveis por inspeção | ✅ L1 condicional às duas premissas do Capítulo 3 |
| 2 | Cobertura ≥ 95% das arestas de δ | ✅ 64/64 células e 100% de código, no contrato principal e no clone |
| 3 | Custo do ciclo completo ≤ R$ 3,00 | ✅ R$ 0,1017 no pior ciclo medido (disputa, CIDv1); R$ 0,4505 com implantação e `approve` |
| 4 | Zero alertas Alta/Média no Slither | ✅ 8 achados Baixa/Informacional |

---

## 6. Pendências classificadas

### Resolvidas nesta revisão
- Chave da API retirada do código (falta revogar a chave antiga).
- Metodologia única para `P_gas` (mediana de 30 dias).
- Validação completa da variante clonável (matriz, transições, acesso, fábrica, S1, reentrância, cobertura).
- Gás do ciclo sobre o clone medido e incluído em `scripts/medirGasReal.ts`.
- Slither reexecutado (8 achados).

### Pendentes do autor
- Revogar a chave antiga da Owlracle.
- Conferir a PTAX de 21/08/2026 no Banco Central e registrar a fonte de `P_POL`.
- Guardar a resposta bruta da Owlracle de 23/08/2026 (a API devolve sempre os 30 dias anteriores à execução).

### Limitações declaradas e trabalhos futuros
- **Premissas `t0 < τ_aceite` e `Δt_insp > 0`:** mantidas como premissas de instanciação. P é aceito pelo prestador em σ1 e pelo contratante em σ2, e verificá-las em código alteraria o contrato avaliado, exigindo refazer toda a avaliação. Recomendadas como verificação adicional em versão futura.
- **Gás medido em rede local:** pressupõe que a Polygon PoS cobra as mesmas unidades de gás da EVM de referência. Medição em rede de teste pública (Amoy) é trabalho futuro.
- **Adoção do clone como implementação de referência:** a variante está validada pela mesma suíte, mas encarece cada chamada e altera o mapeamento de P (de `immutable` para argumentos anexados ao clone) estabelecido na rastreabilidade do Capítulo 3. A migração é trabalho futuro.
- **Saída de EM_DISPUTA sem árbitro:** um Δt5 que devolvesse os fundos após prazo de arbitragem tornaria L1 incondicional; trabalho futuro.
- **Comparação de custo com escrows existentes:** cabe aos Capítulos 2 e 5.

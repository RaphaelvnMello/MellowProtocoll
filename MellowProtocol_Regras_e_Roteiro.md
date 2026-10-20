# MellowProtocol — Regras de Implementação e Roteiro Técnico Completo

> Documento gerado a partir da especificação formal dos Capítulos 2 e 3 da dissertação. Serve como prompt-mestre para orientar sessões de Claude Code na construção do protocolo. Segue estritamente a Tabela de mapeamento δ e a Tabela de rastreabilidade do Capítulo 3.

---

## ⚠️ Pré-requisito: divergência entre capítulos

O Capítulo 3 (metodologia e rastreabilidade) define **8 estados**, sem `CONCLUIDO_ARBITRAGEM`. O Capítulo 2 ainda retém esse estado extra. Este documento segue o Capítulo 3, porque é ele que estabelece a regra de identidade nominal entre a MEFD e o código. Recomenda-se corrigir o Capítulo 2 antes ou em paralelo à implementação, para que a dissertação não descreva um autômato diferente do que foi codificado.

---

## 1. Vetor de parâmetros imutáveis `P`

Registrado no construtor, imutável após deploy:

```
P = ⟨ αc, αp, v, τ_aceite, τ_financ, τ_exec, Δt_insp, CID_spec ⟩
```

| Parâmetro | Tipo Solidity | Semântica |
|---|---|---|
| `αc` | `address` | Contratante — inicia a solicitação, deposita o colateral |
| `αp` | `address` | Prestador — aceita e recebe o pagamento final |
| `v` | `uint256` | Valor do serviço, em unidades mínimas de um **token ERC-20 estável** (não é ETH/MATIC nativo — usar `IERC20`) |
| `τ_aceite` | `uint256` | Timestamp Unix absoluto limite para `aceitar()` |
| `τ_financ` | `uint256` | Timestamp Unix absoluto limite para `financiar()` após aceite |
| `τ_exec` | `uint256` | Timestamp Unix absoluto limite para conclusão física do serviço |
| `Δt_insp` | `uint256` | Intervalo **relativo** de inspeção concedido ao contratante após a entrega |
| `CID_spec` | `string` | CID IPFS do documento de escopo técnico |

**Parâmetro adicional de implementação (não literal no vetor P do texto, mas tecnicamente necessário):**

| Parâmetro | Tipo Solidity | Semântica |
|---|---|---|
| `token` | `IERC20` (imutável) | Endereço do token ERC-20 estável usado para custódia. Definido no construtor junto com `P`. Em produção, é o endereço do stablecoin real (ex.: USDC na Polygon); em testes, um `MockERC20`. |

Essa é uma decisão de implementação sua, não coberta literalmente pela Equação do vetor P — documentar essa escolha no capítulo de experimentos como extensão necessária do design.

## 2. Conjunto de estados `S` (enum, ordem exata)

```solidity
enum EstadoContrato {
    CRIADO,
    ACEITO,
    FINANCIADO,
    EM_EXECUCAO,
    ENTREGUE,
    EM_DISPUTA,
    CONCLUIDO,
    CANCELADO
}
```

`F = {CONCLUIDO, CANCELADO}` — estados absorventes, sem transições de saída.

## 3. Alfabeto de eventos `Σ` (funções `external`, nomes idênticos)

| Símbolo | Assinatura | Ator autorizado |
|---|---|---|
| σ1 | `aceitar()` | `αp` |
| σ2 | `financiar()` | `αc` |
| σ3 | `iniciarExecucao()` | `αp` |
| σ4 | `confirmarEntrega(string[] cids)` | `αp` |
| σ5 | `aprovarPagamento()` | `αc` |
| σ6 | `abrirDisputa(string[] cids)` | `αc` ou `αp` |
| σ7 | `acionarWatchdog()` | qualquer endereço (público) |
| σ8 | `executarDecisao(uint256 valor)` | módulo/endereço de arbitragem |

## 4. Matriz completa da função de transição δ(s, σ)

| Estado \ σ | σ1 | σ2 | σ3 | σ4 | σ5 | σ6 | σ7 | σ8 |
|---|---|---|---|---|---|---|---|---|
| CRIADO | ACEITO | ∅ | ∅ | ∅ | ∅ | ∅ | CANCELADO | ∅ |
| ACEITO | ∅ | FINANCIADO | ∅ | ∅ | ∅ | ∅ | CANCELADO | ∅ |
| FINANCIADO | ∅ | ∅ | EM_EXECUCAO | ∅ | ∅ | ∅ | EM_DISPUTA | ∅ |
| EM_EXECUCAO | ∅ | ∅ | ∅ | ENTREGUE | ∅ | ∅ | EM_DISPUTA | ∅ |
| ENTREGUE | ∅ | ∅ | ∅ | ∅ | CONCLUIDO | EM_DISPUTA | CONCLUIDO | ∅ |
| EM_DISPUTA | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | CONCLUIDO |
| CONCLUIDO | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| CANCELADO | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |

**Regra de implementação:** cada célula ∅ não recebe cláusula de exclusão explícita — a ausência de `modifier` habilitado para o par (estado, função) já causa `revert` por default. Não implementar `else revert("...")` genérico; deixar a lacuna implícita, como o texto formaliza.

**Regra específica de `financiar()` (σ2) — custódia via ERC-20:**

O texto define `v` como denominado em "unidades mínimas divisíveis de um token estável ERC-20", não em ETH/MATIC nativo. Logo `financiar()` **não é `payable`**; ela transfere o token via `transferFrom`, exigindo `approve` prévio do contratante:

```solidity
function financiar() external emEstado(EstadoContrato.ACEITO) {
    uint256 saldoAntes = token.balanceOf(address(this));
    token.safeTransferFrom(msg.sender, address(this), v);
    uint256 saldoDepois = token.balanceOf(address(this));
    if (saldoDepois - saldoAntes != v) revert DepositoInvalido();
    estado = EstadoContrato.FINANCIADO;
}
```

A verificação `saldoDepois - saldoAntes == v` é o "mecanismo de verificação de diferencial de depósitos pós-execução" (balance delta check) citado na prova de S1 (Capítulo 3) — protege contra tokens fee-on-transfer ou rebasing que não creditam exatamente `v`. Usar `SafeERC20.safeTransferFrom` (OpenZeppelin) em vez de `IERC20.transferFrom` direto, para tratar tokens que não retornam `bool` de forma padronizada (ex.: USDT).

Como `transferFrom` não aciona callback no `msg.sender`, essa função específica tem superfície de reentrância praticamente nula — o foco de `nonReentrant` deve ficar nas funções de **saída** de fundos (`aprovarPagamento`, `acionarWatchdog` em ENTREGUE, `executarDecisao`), que usam `safeTransfer` para o(s) destinatário(s).

## 5. Watchdog timers (relógios C = {Δt1, Δt2, Δt3, Δt4})

| Timer | Estado ativo | Condição | Transição | Destino financeiro |
|---|---|---|---|---|
| Δt1 | CRIADO | `t > τ_aceite` | → CANCELADO | Sem saldo, retorno nulo |
| Δt2 | ACEITO | `t > τ_financ` | → CANCELADO | Sem saldo, retorno nulo |
| Δt3 | FINANCIADO ou EM_EXECUCAO | `t > τ_exec` | → EM_DISPUTA | Ativos congelados p/ arbitragem |
| Δt4 | ENTREGUE | `t > τ_ent + Δt_insp` | → CONCLUIDO | Liberação automática a `αp` |

`τ_ent` é o `block.timestamp` gravado dinamicamente na transição EM_EXECUCAO → ENTREGUE (não é fixado no deploy, ao contrário de τ_aceite/τ_financ/τ_exec). `acionarWatchdog()` deve ler o estado corrente e aplicar a guarda correspondente — uma única função pública despachando para os 4 casos, todos usando `block.timestamp`.

## 6. Regra de rastreabilidade nome-a-nome (Cap. 3, Seção 3.3)

- `S` → `enum EstadoContrato`, rótulos idênticos, mesma ordem.
- `Σ` → as 8 funções `external`, nomes e assinaturas idênticos.
- `δ` → um `modifier` de guarda por função: `require(estado == EstadoContrato.X)` no início, `estado = EstadoContrato.Y` ao final, onde (X, Y) vem diretamente da linha correspondente da matriz.
- Transições indefinidas → ausência do modifier habilitado, sem cláusula explícita.

Não usar nomenclatura de código independente que precise ser reconciliada depois com a especificação.

## 7. Stack técnica obrigatória

- **Solidity 0.8.20** — aritmética checked nativa, sem SafeMath.
- **Custom Errors** (`error EstadoInvalido();` etc.) em vez de `require(cond, "string")` — reduz calldata de reverts em até 50%.
- **OpenZeppelin v5.x**: `ReentrancyGuard` (`nonReentrant` nas funções que movimentam fundos) e `Clones` (EIP-1167) para deploy de proxies mínimos via fábrica.
- **Token de custódia:** ERC-20 estável, não ETH/MATIC nativo — `financiar()` deve usar `SafeERC20.safeTransferFrom` com verificação de diferencial de saldo pós-execução (balance delta check), não `payable`. Endereço do token é parâmetro imutável do construtor (ver Seção 1).
- **Saídas de fundos** (`aprovarPagamento`, watchdog Δt4, `executarDecisao`) usam `SafeERC20.safeTransfer` para o(s) destinatário(s), protegidas por `nonReentrant`.
- **Otimizador:** `{ enabled: true, runs: 200 }` no `hardhat.config.ts`.
- **Ordem checks-effects-interactions** em toda função que move fundos, para sustentar a prova de S1/S2 por inspeção e não acionar `reentrancy-eth` no Slither.
- **Evento obrigatório:** `DisputaResolvida(address contratante, address prestador, uint256 valorLiberado)` emitido em `executarDecisao`.

---

# Roteiro de Testes, Gás e Auditoria Estática

## Fase A — Suíte de testes (Mocha + Chai + Hardhat, TypeScript)

**Pré-requisito de fixture:** como a custódia é via ERC-20, toda suíte precisa de um token mock. Criar `contracts/mocks/MockERC20.sol`, um ERC-20 mintável sem restrições (OpenZeppelin `ERC20` + função `mint(address, uint256)` pública, só para ambiente de teste), e no `beforeEach`/fixture de cada arquivo de teste:

```typescript
const token = await MockERC20.deploy("Mock USD", "mUSD", 6);
await token.mint(contratante.address, valorServico);
await token.connect(contratante).approve(mellowProtocol.address, valorServico);
```

Sem esse `approve` prévio, qualquer teste que chame `financiar()` reverte por `ERC20InsufficientAllowance`, não por lógica do MellowProtocol — é fácil confundir os dois tipos de falha nos primeiros testes.

Estrutura recomendada de arquivos em `test/`:

1. **`nominal.test.ts`** — Caminho nominal completo `CRIADO → ACEITO → FINANCIADO → EM_EXECUCAO → ENTREGUE → CONCLUIDO` via σ1, σ2, σ3, σ4, σ5, verificando emissão de eventos e saldo em cada etapa.

2. **`watchdog.test.ts`** — Um teste isolado por timer (Δt1–Δt4), usando `evm_increaseTime` + `evm_mine` para simular a expiração de cada prazo e confirmar a transição determinística correta:
   - Δt1: CRIADO parado além de τ_aceite → σ7 leva a CANCELADO.
   - Δt2: ACEITO parado além de τ_financ → σ7 leva a CANCELADO.
   - Δt3: FINANCIADO/EM_EXECUCAO além de τ_exec → σ7 leva a EM_DISPUTA.
   - Δt4: ENTREGUE além de τ_ent + Δt_insp → σ7 leva a CONCLUIDO com liberação a αp.
   - Testar também que `acionarWatchdog()` reverte se chamado **antes** do prazo (guarda temporal não satisfeita).

3. **`accessControl.test.ts`** — Instanciar sistematicamente todos os pares (estado, evento) com δ = ∅ da matriz da Seção 4, incluindo:
   - Chamadas fora de sequência (ex.: `financiar()` em CRIADO).
   - Chamadas por atores não autorizados (ex.: `aceitar()` chamado pelo contratante em vez do prestador).
   - Confirmar `revert` com o custom error correto e saldo inalterado em cada caso.

4. **`reentrancy.test.ts`** — Deploy de um contrato "exploiter" que tenta reentrar via `fallback`/`receive` durante uma função de liberação de fundos (σ5, σ7 em ENTREGUE, ou σ8), confirmando que `nonReentrant` bloqueia a chamada recursiva.

**Meta de cobertura:** ≥ 95% das arestas de transição de estado, medida via `solidity-coverage`.

```bash
npx hardhat coverage
```

## Fase B — Análise de gás e viabilidade econômica

1. Instalar e configurar `hardhat-gas-reporter` no `hardhat.config.ts` (ativar `gasReporter: { enabled: true, currency: "USD" }` ou similar).
2. Rodar a suíte nominal completa coletando o gás de cada uma das 8 funções.
3. Aplicar a fórmula de conversão para BRL:

```
C_BRL(f) = G(f) × P_gas × 10⁻⁹ × P_MATIC × P_USD/BRL
```

onde `G(f)` é o gás consumido pela função `f`, `P_gas` a mediana do gas price em Gwei na Polygon (últimos 30 dias), `P_MATIC` a cotação MATIC/USD, e `P_USD/BRL` a taxa de câmbio.

4. Somar o custo agregado do ciclo de vida completo (σ1→σ5 ou caminho de disputa) e verificar:

```
Σ C_BRL(ciclo completo) ≤ 1,5% × R$ 200,00 = R$ 3,00
```

5. Documentar a economia de deploy obtida com o padrão Minimal Proxy (EIP-1167) na fábrica de contratos — a dissertação cita ~91% de economia por instância.

## Fase C — Auditoria estática (Slither)

```bash
pip install slither-analyzer
slither . --exclude-dependencies
```

Detectores prioritários a verificar explicitamente:
- `reentrancy-eth` / `reentrancy-no-eth`
- `unchecked-transfer`
- `controlled-delegatecall`
- `suicidal`

**Critério de conformidade:** zero alertas de severidade Alta ou Média em aberto. Documentar cada alerta encontrado (mesmo os de severidade Baixa/Informacional) e a justificativa de aceite ou correção, para o capítulo de experimentos.

## Fase D — Critério de sucesso consolidado (4 condições conjuntivas)

O protocolo só é considerado validado se **todas** as condições abaixo forem satisfeitas simultaneamente:

1. As propriedades formais S1 (integridade do saldo), S2 (unicidade do destinatário) e L1 (ausência de deadlock/vivacidade) permanecem verificáveis por inspeção sobre o código, fielmente ao mapeamento da Seção 4/6 deste documento.
2. Cobertura de testes ≥ 95% das arestas de δ (Fase A).
3. Custo agregado de gás do ciclo de vida completo ≤ 1,5% de R$ 200,00 (Fase B).
4. Zero alertas Alta/Média no Slither (Fase C).

---

## Ordem de execução recomendada para o Claude Code

1. Setup do projeto Hardhat + dependências (OpenZeppelin, gas-reporter, coverage).
2. Implementar `IArbitration.sol` (interface do módulo externo, tratado como caixa-preta) e `mocks/MockERC20.sol` (token de teste).
3. Implementar `MellowProtocol.sol` seguindo Seções 1–7 à risca, com `token` (`IERC20`) como parâmetro imutável do construtor e `financiar()`/saídas via `SafeERC20`.
4. Compilar e revisar manualmente a matriz δ implementada contra a Seção 4.
5. Escrever `nominal.test.ts` primeiro — valida o esqueleto básico.
6. Escrever `accessControl.test.ts` — valida todas as guardas.
7. Escrever `watchdog.test.ts` — valida os 4 relógios.
8. Escrever `reentrancy.test.ts` — valida a proteção de segurança.
9. Rodar `hardhat coverage`, iterar até ≥ 95%.
10. Rodar `hardhat-gas-reporter`, calcular conversão BRL, ajustar `optimizer runs` se necessário para o teto de 1,5%.
11. Rodar Slither, resolver todos os achados Alta/Média.
12. Consolidar os 4 critérios de sucesso em um relatório para o Capítulo de Experimentos.

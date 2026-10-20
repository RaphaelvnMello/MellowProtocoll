# MellowProtocol

Implementação de referência da MEFD (Máquina de Estados Finita Determinística) formalizada nos Capítulos 2 e 3 da dissertação. Ver [MellowProtocol_Regras_e_Roteiro.md](MellowProtocol_Regras_e_Roteiro.md) para a especificação completa e [RELATORIO_EXPERIMENTOS.md](RELATORIO_EXPERIMENTOS.md) para os resultados consolidados de testes, gás e auditoria estática.

## Estrutura

```
contracts/
  MellowProtocol.sol        — contrato principal (S, Σ, δ, watchdog)
  interfaces/IArbitration.sol
  mocks/                     — MockERC20, MaliciousERC20, FeeOnTransferERC20,
                                ReentrancyExploiter (uso exclusivo em testes)
  experimental/              — MellowProtocolClonable + MellowProtocolCloneFactory
                                (EIP-1167 via Clones.cloneWithImmutableArgs —
                                ver RELATORIO_EXPERIMENTOS.md, Seção 3.3)
test/
  fixtures.ts                — deploy padrão reutilizado pelas suítes
  nominal.test.ts             — caminho σ1→σ5 completo
  accessControl.test.ts       — controle de acesso por ator
  matrizEstados.test.ts       — varredura completa da matriz δ (64 células)
  watchdog.test.ts            — timers Δt1–Δt4
  reentrancy.test.ts          — proteção nonReentrant nas 3 saídas de fundos
  dispute.test.ts             — σ6/σ8, construtor, balance delta check, prazos
  experimental/clonable.test.ts — correção funcional e gás da fábrica de clones
  experimental/clonableConformidade.test.ts — matriz δ, transições, acesso,
                                reentrância e S1 sobre o clone (68 testes)
scripts/
  medirGasReal.ts             — gás por recibo (receipt.gasUsed), não por
                                média do gas-reporter, inclusive sobre o clone
gas.py                        — mediana de 30 dias de P_gas (Owlracle) e
                                conversão para BRL; requer OWLRACLE_API_KEY
```

## Comandos

```bash
npm install
npm run compile     # hardhat compile
npm test            # suíte completa (Mocha/Chai)
npm run coverage     # solidity-coverage — meta ≥95% em MellowProtocol.sol
npm run gas          # hardhat-gas-reporter
npm run slither       # requer slither-analyzer no PATH (pip install slither-analyzer)
npx hardhat run scripts/medirGasReal.ts   # gás real por recibo, cenário a cenário
OWLRACLE_API_KEY=... python gas.py        # P_gas (a chave nunca vai para o repositório)
```

## Divergência de capítulos

Este código segue o Capítulo 3 (8 estados, sem `CONCLUIDO_ARBITRAGEM`), conforme a Seção "Pré-requisito" do roteiro. O Capítulo 2 ainda precisa ser atualizado para não descrever um autômato diferente do implementado.

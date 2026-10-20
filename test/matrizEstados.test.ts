import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployMellowProtocolFixture,
  avancarAteEmExecucao,
  avancarAteEntregue,
  avancarAteEmDisputa,
  avancarAteConcluido,
} from "./fixtures";

type Ctx = Awaited<ReturnType<typeof deployMellowProtocolFixture>>;

/// Cobertura sistemática e exaustiva da matriz δ (Seção 4 do roteiro):
/// 8 estados × 8 σ = 64 células, das quais 12 são transições definidas
/// (cobertas em nominal/watchdog/dispute.test.ts) e 52 são ∅.
///
/// Correção de uma lacuna encontrada em revisão: accessControl.test.ts
/// exercitava apenas 23/52 células ∅ (35/64 = 54,7% da matriz completa) de
/// forma ad hoc — o critério de cobertura do roteiro usa `solidity-coverage`
/// (linhas/branches de código), que não é a mesma métrica que "arestas da
/// matriz δ" cobertas uma a uma. Este arquivo fecha as 52/52 células ∅ de
/// forma sistemática e substitui a verificação ad hoc equivalente antes
/// feita em accessControl.test.ts ("chamadas fora de sequência").
///
/// Cada σ é chamado pelo ator CORRETO quando a função tem ator restrito
/// (prestador para σ1/σ3/σ4, contratante para σ2/σ5, contratante para σ6,
/// arbitragem para σ8, qualquer um para σ7 — público). Isso isola a falha
/// no guard de ESTADO (`EstadoInvalido`) da falha no guard de ATOR
/// (`NaoAutorizado`, já coberta em accessControl.test.ts): como os
/// modifiers de ator vêm antes de `emEstado` na assinatura de cada função,
/// uma chamada com ator errado reverteria por NaoAutorizado mesmo em
/// estados onde δ está definido — o que mascararia a célula ∅ que este
/// teste precisa comprovar.
describe("MellowProtocol — matriz δ completa (52 células ∅)", function () {
  const TODOS_SIGMAS = [
    "aceitar",
    "financiar",
    "iniciarExecucao",
    "confirmarEntrega",
    "aprovarPagamento",
    "abrirDisputa",
    "acionarWatchdog",
    "executarDecisao",
  ] as const;

  type NomeSigma = (typeof TODOS_SIGMAS)[number];

  function construirChamadas(ctx: Ctx): Record<NomeSigma, () => Promise<unknown>> {
    const { mellow, contratante, prestador, arbitragem, outro } = ctx;
    return {
      aceitar: () => mellow.connect(prestador).aceitar(),
      financiar: () => mellow.connect(contratante).financiar(),
      iniciarExecucao: () => mellow.connect(prestador).iniciarExecucao(),
      confirmarEntrega: () => mellow.connect(prestador).confirmarEntrega(["cid-generico"]),
      aprovarPagamento: () => mellow.connect(contratante).aprovarPagamento(),
      abrirDisputa: () => mellow.connect(contratante).abrirDisputa(["cid-generico"]),
      acionarWatchdog: () => mellow.connect(outro).acionarWatchdog(),
      executarDecisao: () => mellow.connect(arbitragem).executarDecisao(0n),
    };
  }

  const CASOS: { estado: string; validos: NomeSigma[]; chegar: (ctx: Ctx) => Promise<void> }[] = [
    { estado: "CRIADO", validos: ["aceitar", "acionarWatchdog"], chegar: async () => {} },
    {
      estado: "ACEITO",
      validos: ["financiar", "acionarWatchdog"],
      chegar: async (ctx) => {
        await ctx.mellow.connect(ctx.prestador).aceitar();
      },
    },
    {
      estado: "FINANCIADO",
      validos: ["iniciarExecucao", "acionarWatchdog"],
      chegar: async (ctx) => {
        await ctx.mellow.connect(ctx.prestador).aceitar();
        await ctx.mellow.connect(ctx.contratante).financiar();
      },
    },
    { estado: "EM_EXECUCAO", validos: ["confirmarEntrega", "acionarWatchdog"], chegar: avancarAteEmExecucao },
    {
      estado: "ENTREGUE",
      validos: ["aprovarPagamento", "abrirDisputa", "acionarWatchdog"],
      chegar: avancarAteEntregue,
    },
    { estado: "EM_DISPUTA", validos: ["executarDecisao"], chegar: avancarAteEmDisputa },
    { estado: "CONCLUIDO", validos: [], chegar: avancarAteConcluido },
    {
      estado: "CANCELADO",
      validos: [],
      chegar: async (ctx) => {
        await time.increaseTo(ctx.tauAceite + 1);
        await ctx.mellow.acionarWatchdog();
      },
    },
  ];

  for (const caso of CASOS) {
    describe(`estado ${caso.estado}`, function () {
      const naoValidos = TODOS_SIGMAS.filter((s) => !caso.validos.includes(s));

      for (const sigma of naoValidos) {
        it(`${sigma}() reverte com EstadoInvalido — δ(${caso.estado}, ${sigma}) = ∅`, async function () {
          const ctx = await loadFixture(deployMellowProtocolFixture);
          await caso.chegar(ctx);

          const chamadas = construirChamadas(ctx);
          await expect(chamadas[sigma]()).to.be.revertedWithCustomError(ctx.mellow, "EstadoInvalido");
        });
      }
    });
  }

  it("a enumeração cobre exatamente as 64 células da matriz (12 definidas + 52 ∅)", function () {
    const totalCelulas = CASOS.length * TODOS_SIGMAS.length;
    const totalDefinidas = CASOS.reduce((acc, c) => acc + c.validos.length, 0);
    const totalVazias = CASOS.reduce((acc, c) => acc + (TODOS_SIGMAS.length - c.validos.length), 0);

    expect(CASOS.length).to.equal(8);
    expect(TODOS_SIGMAS.length).to.equal(8);
    expect(totalCelulas).to.equal(64);
    expect(totalDefinidas).to.equal(12);
    expect(totalVazias).to.equal(52);
  });
});

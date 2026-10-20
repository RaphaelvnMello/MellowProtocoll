import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployMellowProtocolFixture, avancarAteEmExecucao, avancarAteEntregue } from "./fixtures";

/// Controle de acesso por ATOR (Fase A, item 3 do roteiro): chamadas por
/// endereços não autorizados para cada σ. A cobertura sistemática das
/// células (estado, σ) com δ = ∅ — chamadas fora de sequência — está em
/// matrizEstados.test.ts, que cobre as 52 células vazias da matriz de forma
/// exaustiva (este arquivo cobria apenas 23/52 de forma ad hoc antes de ser
/// substituído por aquele teste parametrizado).
describe("MellowProtocol — controle de acesso por ator", function () {
  describe("chamadas por atores não autorizados", function () {
    it("aceitar() reverte se chamado pelo contratante em vez do prestador", async function () {
      const { mellow, contratante } = await loadFixture(deployMellowProtocolFixture);
      await expect(mellow.connect(contratante).aceitar()).to.be.revertedWithCustomError(mellow, "NaoAutorizado");
    });

    it("aceitar() reverte se chamado por terceiro", async function () {
      const { mellow, outro } = await loadFixture(deployMellowProtocolFixture);
      await expect(mellow.connect(outro).aceitar()).to.be.revertedWithCustomError(mellow, "NaoAutorizado");
    });

    it("financiar() reverte se chamado pelo prestador em vez do contratante", async function () {
      const { mellow, prestador } = await loadFixture(deployMellowProtocolFixture);
      await mellow.connect(prestador).aceitar();
      await expect(mellow.connect(prestador).financiar()).to.be.revertedWithCustomError(mellow, "NaoAutorizado");
    });

    it("iniciarExecucao() reverte se chamado pelo contratante em vez do prestador", async function () {
      const { mellow, prestador, contratante } = await loadFixture(deployMellowProtocolFixture);
      await mellow.connect(prestador).aceitar();
      await mellow.connect(contratante).financiar();
      await expect(mellow.connect(contratante).iniciarExecucao()).to.be.revertedWithCustomError(
        mellow,
        "NaoAutorizado"
      );
    });

    it("confirmarEntrega() reverte se chamado pelo contratante em vez do prestador", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEmExecucao(ctx);
      await expect(ctx.mellow.connect(ctx.contratante).confirmarEntrega(["cid"])).to.be.revertedWithCustomError(
        ctx.mellow,
        "NaoAutorizado"
      );
    });

    it("aprovarPagamento() reverte se chamado pelo prestador em vez do contratante", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      await expect(ctx.mellow.connect(ctx.prestador).aprovarPagamento()).to.be.revertedWithCustomError(
        ctx.mellow,
        "NaoAutorizado"
      );
    });

    it("abrirDisputa() reverte se chamado por terceiro (não é αc nem αp)", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      await expect(ctx.mellow.connect(ctx.outro).abrirDisputa(["cid"])).to.be.revertedWithCustomError(
        ctx.mellow,
        "NaoAutorizado"
      );
    });

    it("abrirDisputa() aceita chamada tanto do contratante quanto do prestador", async function () {
      const ctx1 = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx1);
      await expect(ctx1.mellow.connect(ctx1.contratante).abrirDisputa(["cid"])).to.not.be.reverted;

      const ctx2 = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx2);
      await expect(ctx2.mellow.connect(ctx2.prestador).abrirDisputa(["cid"])).to.not.be.reverted;
    });

    it("executarDecisao() reverte se chamado por alguém diferente do módulo de arbitragem", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      await ctx.mellow.connect(ctx.contratante).abrirDisputa(["cid"]);

      await expect(ctx.mellow.connect(ctx.contratante).executarDecisao(0n)).to.be.revertedWithCustomError(
        ctx.mellow,
        "NaoAutorizado"
      );
      await expect(ctx.mellow.connect(ctx.prestador).executarDecisao(0n)).to.be.revertedWithCustomError(
        ctx.mellow,
        "NaoAutorizado"
      );
      await expect(ctx.mellow.connect(ctx.outro).executarDecisao(0n)).to.be.revertedWithCustomError(
        ctx.mellow,
        "NaoAutorizado"
      );
    });

    it("saldo permanece inalterado após qualquer chamada revertida", async function () {
      const { mellow, token, contratante } = await loadFixture(deployMellowProtocolFixture);
      const mellowAddr = await mellow.getAddress();
      const saldoAntes = await token.balanceOf(mellowAddr);

      await expect(mellow.connect(contratante).financiar()).to.be.revertedWithCustomError(
        mellow,
        "EstadoInvalido"
      );

      expect(await token.balanceOf(mellowAddr)).to.equal(saldoAntes);
    });
  });
});

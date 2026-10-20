import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployMellowProtocolFixture, avancarAteEmExecucao, avancarAteEntregue } from "./fixtures";

/// Um teste isolado por timer (Δt1–Δt4), usando evm_increaseTime/evm_mine
/// (via @nomicfoundation/hardhat-network-helpers `time`) para simular a
/// expiração de cada prazo (Fase A, item 2 do roteiro).
describe("MellowProtocol — watchdog timers (Δt1–Δt4)", function () {
  const Estado = {
    CRIADO: 0n,
    ACEITO: 1n,
    FINANCIADO: 2n,
    EM_EXECUCAO: 3n,
    ENTREGUE: 4n,
    EM_DISPUTA: 5n,
    CONCLUIDO: 6n,
    CANCELADO: 7n,
  };

  describe("Δt1 — CRIADO além de τ_aceite → CANCELADO", function () {
    it("reverte se acionarWatchdog() é chamado antes do prazo", async function () {
      const { mellow } = await loadFixture(deployMellowProtocolFixture);
      await expect(mellow.acionarWatchdog()).to.be.revertedWithCustomError(mellow, "PrazoNaoExpirado");
      expect(await mellow.estado()).to.equal(Estado.CRIADO);
    });

    it("transiciona para CANCELADO após τ_aceite, sem movimentação de saldo", async function () {
      const { mellow, token, tauAceite } = await loadFixture(deployMellowProtocolFixture);
      const mellowAddr = await mellow.getAddress();
      const saldoAntes = await token.balanceOf(mellowAddr);

      await time.increaseTo(tauAceite + 1);
      await expect(mellow.acionarWatchdog()).to.emit(mellow, "ContratoCancelado");

      expect(await mellow.estado()).to.equal(Estado.CANCELADO);
      expect(await token.balanceOf(mellowAddr)).to.equal(saldoAntes);
    });

    it("pode ser acionado por qualquer endereço (público)", async function () {
      const { mellow, outro, tauAceite } = await loadFixture(deployMellowProtocolFixture);
      await time.increaseTo(tauAceite + 1);
      await expect(mellow.connect(outro).acionarWatchdog()).to.not.be.reverted;
      expect(await mellow.estado()).to.equal(Estado.CANCELADO);
    });
  });

  describe("Δt2 — ACEITO além de τ_financ → CANCELADO", function () {
    it("reverte se acionado antes do prazo", async function () {
      const { mellow, prestador } = await loadFixture(deployMellowProtocolFixture);
      await mellow.connect(prestador).aceitar();
      await expect(mellow.acionarWatchdog()).to.be.revertedWithCustomError(mellow, "PrazoNaoExpirado");
      expect(await mellow.estado()).to.equal(Estado.ACEITO);
    });

    it("transiciona para CANCELADO após τ_financ, sem movimentação de saldo", async function () {
      const { mellow, token, prestador, tauFinanc } = await loadFixture(deployMellowProtocolFixture);
      const mellowAddr = await mellow.getAddress();
      await mellow.connect(prestador).aceitar();
      const saldoAntes = await token.balanceOf(mellowAddr);

      await time.increaseTo(tauFinanc + 1);
      await expect(mellow.acionarWatchdog()).to.emit(mellow, "ContratoCancelado");

      expect(await mellow.estado()).to.equal(Estado.CANCELADO);
      expect(await token.balanceOf(mellowAddr)).to.equal(saldoAntes);
    });
  });

  describe("Δt3 — FINANCIADO/EM_EXECUCAO além de τ_exec → EM_DISPUTA", function () {
    it("reverte se acionado antes do prazo (estado FINANCIADO)", async function () {
      const { mellow, prestador, contratante } = await loadFixture(deployMellowProtocolFixture);
      await mellow.connect(prestador).aceitar();
      await mellow.connect(contratante).financiar();
      await expect(mellow.acionarWatchdog()).to.be.revertedWithCustomError(mellow, "PrazoNaoExpirado");
      expect(await mellow.estado()).to.equal(Estado.FINANCIADO);
    });

    it("transiciona FINANCIADO → EM_DISPUTA após τ_exec (ativos congelados, saldo mantido)", async function () {
      const { mellow, token, prestador, contratante, tauExec } = await loadFixture(deployMellowProtocolFixture);
      const mellowAddr = await mellow.getAddress();
      await mellow.connect(prestador).aceitar();
      await mellow.connect(contratante).financiar();
      const saldoAntes = await token.balanceOf(mellowAddr);

      await time.increaseTo(tauExec + 1);
      await expect(mellow.acionarWatchdog())
        .to.emit(mellow, "WatchdogAcionado")
        .withArgs(Estado.FINANCIADO, Estado.EM_DISPUTA);

      expect(await mellow.estado()).to.equal(Estado.EM_DISPUTA);
      expect(await token.balanceOf(mellowAddr)).to.equal(saldoAntes);
    });

    it("transiciona EM_EXECUCAO → EM_DISPUTA após τ_exec", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEmExecucao(ctx);

      await time.increaseTo(ctx.tauExec + 1);
      await expect(ctx.mellow.acionarWatchdog())
        .to.emit(ctx.mellow, "WatchdogAcionado")
        .withArgs(Estado.EM_EXECUCAO, Estado.EM_DISPUTA);

      expect(await ctx.mellow.estado()).to.equal(Estado.EM_DISPUTA);
    });
  });

  describe("Δt4 — ENTREGUE além de τ_ent + Δt_insp → CONCLUIDO", function () {
    it("reverte se acionado antes do prazo", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      await expect(ctx.mellow.acionarWatchdog()).to.be.revertedWithCustomError(ctx.mellow, "PrazoNaoExpirado");
      expect(await ctx.mellow.estado()).to.equal(Estado.ENTREGUE);
    });

    it("libera automaticamente o pagamento a αp após τ_ent + Δt_insp", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      const { mellow, token, prestador, valorServico, deltaTInsp } = ctx;
      const mellowAddr = await mellow.getAddress();

      const tauEnt = await mellow.tauEnt();
      await time.increaseTo(tauEnt + BigInt(deltaTInsp) + 1n);

      await expect(mellow.acionarWatchdog())
        .to.emit(mellow, "WatchdogAcionado")
        .withArgs(Estado.ENTREGUE, Estado.CONCLUIDO);

      expect(await mellow.estado()).to.equal(Estado.CONCLUIDO);
      expect(await token.balanceOf(mellowAddr)).to.equal(0n);
      expect(await token.balanceOf(prestador.address)).to.equal(valorServico);
    });
  });

  describe("estados sem relógio ativo (EM_DISPUTA, CONCLUIDO, CANCELADO)", function () {
    it("reverte com EstadoInvalido em EM_DISPUTA", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      await ctx.mellow.connect(ctx.contratante).abrirDisputa(["cid"]);
      await expect(ctx.mellow.acionarWatchdog()).to.be.revertedWithCustomError(ctx.mellow, "EstadoInvalido");
    });

    it("reverte com EstadoInvalido em CONCLUIDO", async function () {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      await avancarAteEntregue(ctx);
      await ctx.mellow.connect(ctx.contratante).aprovarPagamento();
      await expect(ctx.mellow.acionarWatchdog()).to.be.revertedWithCustomError(ctx.mellow, "EstadoInvalido");
    });

    it("reverte com EstadoInvalido em CANCELADO", async function () {
      const { mellow, tauAceite } = await loadFixture(deployMellowProtocolFixture);
      await time.increaseTo(tauAceite + 1);
      await mellow.acionarWatchdog();
      await expect(mellow.acionarWatchdog()).to.be.revertedWithCustomError(mellow, "EstadoInvalido");
    });
  });
});

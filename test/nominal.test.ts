import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployMellowProtocolFixture } from "./fixtures";

/// Caminho nominal completo (Fase A, item 1 do roteiro):
/// CRIADO → ACEITO → FINANCIADO → EM_EXECUCAO → ENTREGUE → CONCLUIDO
/// via σ1, σ2, σ3, σ4, σ5 — verificando eventos e saldo em cada etapa.
describe("MellowProtocol — caminho nominal", function () {
  // EstadoContrato enum, na mesma ordem da Seção 2 do roteiro
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

  it("inicia em CRIADO com o vetor de parâmetros P registrado corretamente", async function () {
    const { mellow, contratante, prestador, valorServico, tauAceite, tauFinanc, tauExec, deltaTInsp, cidSpec, token } =
      await loadFixture(deployMellowProtocolFixture);

    expect(await mellow.estado()).to.equal(Estado.CRIADO);
    expect(await mellow.contratante()).to.equal(contratante.address);
    expect(await mellow.prestador()).to.equal(prestador.address);
    expect(await mellow.v()).to.equal(valorServico);
    expect(await mellow.tauAceite()).to.equal(tauAceite);
    expect(await mellow.tauFinanc()).to.equal(tauFinanc);
    expect(await mellow.tauExec()).to.equal(tauExec);
    expect(await mellow.deltaTInsp()).to.equal(deltaTInsp);
    expect(await mellow.cidSpec()).to.equal(cidSpec);
    expect(await mellow.token()).to.equal(await token.getAddress());
  });

  it("σ1 aceitar(): CRIADO → ACEITO, emite ContratoAceito", async function () {
    const { mellow, prestador } = await loadFixture(deployMellowProtocolFixture);

    await expect(mellow.connect(prestador).aceitar())
      .to.emit(mellow, "ContratoAceito")
      .withArgs(prestador.address);

    expect(await mellow.estado()).to.equal(Estado.ACEITO);
  });

  it("σ2 financiar(): ACEITO → FINANCIADO, transfere v via transferFrom e emite ContratoFinanciado", async function () {
    const { mellow, token, contratante, prestador, valorServico } = await loadFixture(deployMellowProtocolFixture);
    await mellow.connect(prestador).aceitar();

    const mellowAddr = await mellow.getAddress();
    await expect(mellow.connect(contratante).financiar())
      .to.emit(mellow, "ContratoFinanciado")
      .withArgs(contratante.address, valorServico);

    expect(await mellow.estado()).to.equal(Estado.FINANCIADO);
    expect(await token.balanceOf(mellowAddr)).to.equal(valorServico);
    expect(await token.balanceOf(contratante.address)).to.equal(0n);
  });

  it("σ3 iniciarExecucao(): FINANCIADO → EM_EXECUCAO, emite ExecucaoIniciada", async function () {
    const { mellow, contratante, prestador } = await loadFixture(deployMellowProtocolFixture);
    await mellow.connect(prestador).aceitar();
    await mellow.connect(contratante).financiar();

    await expect(mellow.connect(prestador).iniciarExecucao())
      .to.emit(mellow, "ExecucaoIniciada")
      .withArgs(prestador.address);

    expect(await mellow.estado()).to.equal(Estado.EM_EXECUCAO);
  });

  it("σ4 confirmarEntrega(cids): EM_EXECUCAO → ENTREGUE, grava τ_ent e cids, emite EntregaConfirmada", async function () {
    const { mellow, contratante, prestador } = await loadFixture(deployMellowProtocolFixture);
    await mellow.connect(prestador).aceitar();
    await mellow.connect(contratante).financiar();
    await mellow.connect(prestador).iniciarExecucao();

    const cids = ["bafybeih_entrega_cid_1", "bafybeih_entrega_cid_2"];
    const tx = await mellow.connect(prestador).confirmarEntrega(cids);
    const receipt = await tx.wait();
    const bloco = await mellow.runner!.provider!.getBlock(receipt!.blockNumber);

    await expect(tx).to.emit(mellow, "EntregaConfirmada").withArgs(prestador.address, bloco!.timestamp, cids);

    expect(await mellow.estado()).to.equal(Estado.ENTREGUE);
    expect(await mellow.tauEnt()).to.equal(bloco!.timestamp);
    expect(await mellow.cidsEntrega()).to.deep.equal(cids);
  });

  it("σ5 aprovarPagamento(): ENTREGUE → CONCLUIDO, libera v a αp, emite PagamentoAprovado", async function () {
    const { mellow, token, contratante, prestador, valorServico } = await loadFixture(deployMellowProtocolFixture);
    await mellow.connect(prestador).aceitar();
    await mellow.connect(contratante).financiar();
    await mellow.connect(prestador).iniciarExecucao();
    await mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]);

    await expect(mellow.connect(contratante).aprovarPagamento())
      .to.emit(mellow, "PagamentoAprovado")
      .withArgs(contratante.address, prestador.address, valorServico);

    expect(await mellow.estado()).to.equal(Estado.CONCLUIDO);
    expect(await token.balanceOf(await mellow.getAddress())).to.equal(0n);
    expect(await token.balanceOf(prestador.address)).to.equal(valorServico);
  });

  it("caminho completo σ1→σ5 preserva integridade do saldo (S1): saldo final do contrato é zero", async function () {
    const { mellow, token, contratante, prestador } = await loadFixture(deployMellowProtocolFixture);

    await mellow.connect(prestador).aceitar();
    await mellow.connect(contratante).financiar();
    await mellow.connect(prestador).iniciarExecucao();
    await mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]);
    await mellow.connect(contratante).aprovarPagamento();

    expect(await mellow.estado()).to.equal(Estado.CONCLUIDO);
    expect(await token.balanceOf(await mellow.getAddress())).to.equal(0n);
  });
});

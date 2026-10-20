import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// Deploy de um contrato "exploiter" que tenta reentrar via fallback/receive
/// durante uma função de liberação de fundos (σ5, σ7 em ENTREGUE, e σ8),
/// confirmando que `nonReentrant` bloqueia a chamada recursiva
/// (Fase A, item 4 do roteiro).
///
/// Como `SafeERC20.safeTransfer` não aciona callback no destinatário para um
/// ERC-20 padrão, o cenário usa MaliciousERC20 — um token cujo `transfer`
/// aciona o fallback/receive de um endereço "gatilho" configurável — para
/// simular um destinatário malicioso tentando reentrar durante o saque. O
/// exploiter é posicionado como αp (prestador), pois é ele quem recebe os
/// fundos liberados nas três funções de saída.
describe("MellowProtocol — proteção contra reentrância", function () {
  const decimals = 6;
  const cids = ["bafybeih_entrega_cid"];

  async function chegarAteEntregueComExploiter() {
    const [contratanteEOA, , arbitragem, outro] = await ethers.getSigners();
    const valorServico = ethers.parseUnits("1000", decimals);

    const MaliciousERC20 = await ethers.getContractFactory("MaliciousERC20");
    const token = await MaliciousERC20.deploy("Malicious USD", "mxUSD", decimals);
    await token.waitForDeployment();

    const ReentrancyExploiter = await ethers.getContractFactory("ReentrancyExploiter");
    const exploiter = await ReentrancyExploiter.deploy();
    await exploiter.waitForDeployment();
    const exploiterAddr = await exploiter.getAddress();

    const agora = await time.latest();
    const tauAceite = agora + 3 * 24 * 60 * 60;
    const tauFinanc = agora + 6 * 24 * 60 * 60;
    const tauExec = agora + 20 * 24 * 60 * 60;
    const deltaTInsp = 5 * 24 * 60 * 60;

    const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
    const mellow = await MellowProtocol.deploy(
      contratanteEOA.address,
      exploiterAddr, // αp = exploiter
      valorServico,
      tauAceite,
      tauFinanc,
      tauExec,
      deltaTInsp,
      "cid-spec-reentrancy",
      await token.getAddress(),
      arbitragem.address
    );
    await mellow.waitForDeployment();
    const mellowAddr = await mellow.getAddress();

    // O token malicioso aciona o fallback/receive do exploiter sempre que
    // ele recebe uma transferência.
    await token.setGatilho(exploiterAddr);
    await token.mint(contratanteEOA.address, valorServico);
    await token.connect(contratanteEOA).approve(mellowAddr, valorServico);

    // σ1, σ2, σ3, σ4 — o exploiter atua como αp via `executar`.
    await exploiter.executar(mellowAddr, mellow.interface.encodeFunctionData("aceitar"));
    await mellow.connect(contratanteEOA).financiar();
    await exploiter.executar(mellowAddr, mellow.interface.encodeFunctionData("iniciarExecucao"));
    await exploiter.executar(mellowAddr, mellow.interface.encodeFunctionData("confirmarEntrega", [cids]));

    return { mellow, mellowAddr, token, exploiter, contratanteEOA, arbitragem, outro, valorServico, deltaTInsp };
  }

  it("aprovarPagamento() (σ5): reentrada é bloqueada por nonReentrant", async function () {
    const { mellow, mellowAddr, exploiter, contratanteEOA } = await chegarAteEntregueComExploiter();

    await exploiter.configurarAtaque(mellowAddr, mellow.interface.encodeFunctionData("aprovarPagamento"));

    await expect(mellow.connect(contratanteEOA).aprovarPagamento()).to.not.be.reverted;

    expect(await exploiter.tentouReentrar()).to.equal(true);
    expect(await exploiter.reentradaBemSucedida()).to.equal(false);
    expect(await mellow.estado()).to.equal(6n); // CONCLUIDO
  });

  it("acionarWatchdog() em ENTREGUE (σ7, Δt4): reentrada é bloqueada por nonReentrant", async function () {
    const { mellow, mellowAddr, exploiter, outro, deltaTInsp } = await chegarAteEntregueComExploiter();

    await exploiter.configurarAtaque(mellowAddr, mellow.interface.encodeFunctionData("acionarWatchdog"));

    const tauEnt = await mellow.tauEnt();
    await time.increaseTo(tauEnt + BigInt(deltaTInsp) + 1n);

    await expect(mellow.connect(outro).acionarWatchdog()).to.not.be.reverted;

    expect(await exploiter.tentouReentrar()).to.equal(true);
    expect(await exploiter.reentradaBemSucedida()).to.equal(false);
    expect(await mellow.estado()).to.equal(6n); // CONCLUIDO
  });

  it("executarDecisao() (σ8): reentrada é bloqueada por nonReentrant", async function () {
    const { mellow, mellowAddr, exploiter, contratanteEOA, arbitragem, valorServico } =
      await chegarAteEntregueComExploiter();

    await mellow.connect(contratanteEOA).abrirDisputa(["cid-disputa"]);

    await exploiter.configurarAtaque(
      mellowAddr,
      mellow.interface.encodeFunctionData("executarDecisao", [valorServico])
    );

    await expect(mellow.connect(arbitragem).executarDecisao(valorServico)).to.not.be.reverted;

    expect(await exploiter.tentouReentrar()).to.equal(true);
    expect(await exploiter.reentradaBemSucedida()).to.equal(false);
    expect(await mellow.estado()).to.equal(6n); // CONCLUIDO
  });

  it("financiar() (σ2): reentrada em acionarWatchdog durante o depósito é bloqueada", async function () {
    // Cenário: o contratante é um contrato e o token aciona um gancho no
    // remetente durante transferFrom (à semelhança do ERC-777). Após τ_financ,
    // o gancho tenta executar σ7 no meio de σ2, o que levaria o contrato a
    // CANCELADO de forma transitória e emitiria ContratoCancelado.
    const [, prestador, arbitragem] = await ethers.getSigners();
    const valorServico = ethers.parseUnits("1000", decimals);

    const token = await (await ethers.getContractFactory("MaliciousERC20")).deploy("Malicious USD", "mxUSD", decimals);
    const exploiter = await (await ethers.getContractFactory("ReentrancyExploiter")).deploy();
    const exploiterAddr = await exploiter.getAddress();

    const agora = await time.latest();
    const tauFinanc = agora + 6 * 24 * 60 * 60;
    const mellow = await (await ethers.getContractFactory("MellowProtocol")).deploy(
      exploiterAddr, // αc = exploiter
      prestador.address,
      valorServico,
      agora + 3 * 24 * 60 * 60,
      tauFinanc,
      agora + 20 * 24 * 60 * 60,
      5 * 24 * 60 * 60,
      "cid-spec-reentrancy-financiar",
      await token.getAddress(),
      arbitragem.address
    );
    const mellowAddr = await mellow.getAddress();

    await mellow.connect(prestador).aceitar();
    await token.mint(exploiterAddr, valorServico);
    await exploiter.executar(await token.getAddress(), token.interface.encodeFunctionData("approve", [mellowAddr, valorServico]));
    await token.setGatilho(exploiterAddr);
    await time.increaseTo(tauFinanc + 1);
    await exploiter.configurarAtaque(mellowAddr, mellow.interface.encodeFunctionData("acionarWatchdog"));

    const tx = await exploiter.executar(mellowAddr, mellow.interface.encodeFunctionData("financiar"));
    const recibo = await tx.wait();
    const cancelamentos = recibo!.logs
      .map((l: any) => {
        try {
          return mellow.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((e: any) => e?.name === "ContratoCancelado");

    expect(await exploiter.tentouReentrar()).to.equal(true);
    expect(await exploiter.reentradaBemSucedida()).to.equal(false);
    expect(cancelamentos.length).to.equal(0);
    expect(await mellow.estado()).to.equal(2n); // FINANCIADO
    expect(await token.balanceOf(mellowAddr)).to.equal(valorServico);
  });
  it("financiar() (σ2): reentrada em financiar durante o depósito é bloqueada", async function () {
    // Cenário: o contratante é um contrato e o token aciona um gancho no
    // remetente durante transferFrom (à semelhança do ERC-777). Após τ_financ,
    // o gancho tenta executar σ7 no meio de σ2, o que levaria o contrato a
    // CANCELADO de forma transitória e emitiria ContratoCancelado.
    const [, prestador, arbitragem] = await ethers.getSigners();
    const valorServico = ethers.parseUnits("1000", decimals);

    const token = await (await ethers.getContractFactory("MaliciousERC20")).deploy("Malicious USD", "mxUSD", decimals);
    const exploiter = await (await ethers.getContractFactory("ReentrancyExploiter")).deploy();
    const exploiterAddr = await exploiter.getAddress();

    const agora = await time.latest();
    const tauFinanc = agora + 6 * 24 * 60 * 60;
    const mellow = await (await ethers.getContractFactory("MellowProtocol")).deploy(
      exploiterAddr, // αc = exploiter
      prestador.address,
      valorServico,
      agora + 3 * 24 * 60 * 60,
      tauFinanc,
      agora + 20 * 24 * 60 * 60,
      5 * 24 * 60 * 60,
      "cid-spec-reentrancy-financiar-2",
      await token.getAddress(),
      arbitragem.address
    );
    const mellowAddr = await mellow.getAddress();

    await mellow.connect(prestador).aceitar();
    await token.mint(exploiterAddr, valorServico);
    await exploiter.executar(await token.getAddress(), token.interface.encodeFunctionData("approve", [mellowAddr, valorServico]));
    await token.setGatilho(exploiterAddr);
    await time.increaseTo(tauFinanc + 1);
    await exploiter.configurarAtaque(mellowAddr, mellow.interface.encodeFunctionData("financiar"));

    const tx = await exploiter.executar(mellowAddr, mellow.interface.encodeFunctionData("financiar"));
    const recibo = await tx.wait();
    const cancelamentos = recibo!.logs
      .map((l: any) => {
        try {
          return mellow.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((e: any) => e?.name === "ContratoCancelado");

    expect(await exploiter.tentouReentrar()).to.equal(true);
    expect(await exploiter.reentradaBemSucedida()).to.equal(false);
    expect(cancelamentos.length).to.equal(0);
    expect(await mellow.estado()).to.equal(2n); // FINANCIADO
    expect(await token.balanceOf(mellowAddr)).to.equal(valorServico);
  });
});

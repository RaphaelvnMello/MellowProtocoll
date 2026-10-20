import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployMellowProtocolFixture, avancarAteEntregue } from "./fixtures";

/// Cobre os caminhos felizes de σ6 (abrirDisputa) e σ8 (executarDecisao) —
/// EM_DISPUTA → CONCLUIDO — e a validação do construtor (Seção 1), para
/// completar a cobertura de arestas de δ além do caminho nominal (item 9 do
/// roteiro: iterar até ≥ 95% de cobertura).
describe("MellowProtocol — resolução de disputa e validação de construtor", function () {
  const Estado = { EM_DISPUTA: 5n, CONCLUIDO: 6n };

  it("σ6 abrirDisputa(): ENTREGUE → EM_DISPUTA, emite DisputaAberta e registra cids", async function () {
    const ctx = await loadFixture(deployMellowProtocolFixture);
    await avancarAteEntregue(ctx);
    const { mellow, contratante } = ctx;

    const cids = ["cid-disputa-1"];
    await expect(mellow.connect(contratante).abrirDisputa(cids))
      .to.emit(mellow, "DisputaAberta")
      .withArgs(contratante.address, cids);

    expect(await mellow.estado()).to.equal(Estado.EM_DISPUTA);
    expect(await mellow.cidsDisputa()).to.deep.equal(cids);
  });

  it("σ8 executarDecisao(valor parcial): EM_DISPUTA → CONCLUIDO, divide o saldo entre αp e αc", async function () {
    const ctx = await loadFixture(deployMellowProtocolFixture);
    await avancarAteEntregue(ctx);
    const { mellow, token, contratante, prestador, arbitragem, valorServico } = ctx;
    const mellowAddr = await mellow.getAddress();

    await mellow.connect(contratante).abrirDisputa(["cid-disputa"]);

    const valorAoPrestador = valorServico / 4n;
    const valorAoContratante = valorServico - valorAoPrestador;

    await expect(mellow.connect(arbitragem).executarDecisao(valorAoPrestador))
      .to.emit(mellow, "DisputaResolvida")
      .withArgs(contratante.address, prestador.address, valorAoPrestador);

    expect(await mellow.estado()).to.equal(Estado.CONCLUIDO);
    expect(await token.balanceOf(mellowAddr)).to.equal(0n);
    expect(await token.balanceOf(prestador.address)).to.equal(valorAoPrestador);
    expect(await token.balanceOf(contratante.address)).to.equal(valorAoContratante);
  });

  it("σ8 executarDecisao(0): totalidade do saldo retorna a αc, nada a αp", async function () {
    const ctx = await loadFixture(deployMellowProtocolFixture);
    await avancarAteEntregue(ctx);
    const { mellow, token, contratante, prestador, arbitragem, valorServico } = ctx;

    await mellow.connect(contratante).abrirDisputa(["cid-disputa"]);
    await mellow.connect(arbitragem).executarDecisao(0n);

    expect(await mellow.estado()).to.equal(Estado.CONCLUIDO);
    expect(await token.balanceOf(prestador.address)).to.equal(0n);
    expect(await token.balanceOf(contratante.address)).to.equal(valorServico);
  });

  it("σ8 executarDecisao(valor > v) reverte com ValorInvalido", async function () {
    const ctx = await loadFixture(deployMellowProtocolFixture);
    await avancarAteEntregue(ctx);
    const { mellow, contratante, arbitragem, valorServico } = ctx;

    await mellow.connect(contratante).abrirDisputa(["cid-disputa"]);
    await expect(mellow.connect(arbitragem).executarDecisao(valorServico + 1n)).to.be.revertedWithCustomError(
      mellow,
      "ValorInvalido"
    );
  });

  it("financiar() reverte com DepositoInvalido para token fee-on-transfer (balance delta check — prova S1)", async function () {
    const [contratante, prestador, arbitragem] = await ethers.getSigners();
    const valorServico = ethers.parseUnits("1000", 6);

    const FeeOnTransferERC20 = await ethers.getContractFactory("FeeOnTransferERC20");
    // 1% de taxa: safeTransferFrom credita menos que `v`, disparando a guarda.
    const token = await FeeOnTransferERC20.deploy("Fee USD", "fUSD", 6, 100);
    await token.waitForDeployment();
    await token.mint(contratante.address, valorServico);

    const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
    const mellow = await MellowProtocol.deploy(
      contratante.address,
      prestador.address,
      valorServico,
      (await ethers.provider.getBlock("latest"))!.timestamp + 3 * 24 * 60 * 60,
      (await ethers.provider.getBlock("latest"))!.timestamp + 6 * 24 * 60 * 60,
      (await ethers.provider.getBlock("latest"))!.timestamp + 20 * 24 * 60 * 60,
      5 * 24 * 60 * 60,
      "cid-fee-on-transfer",
      await token.getAddress(),
      arbitragem.address
    );
    await mellow.waitForDeployment();

    await token.connect(contratante).approve(await mellow.getAddress(), valorServico);
    await mellow.connect(prestador).aceitar();

    await expect(mellow.connect(contratante).financiar()).to.be.revertedWithCustomError(mellow, "DepositoInvalido");
    expect(await mellow.estado()).to.equal(1n); // permanece ACEITO
  });

  describe("validação do construtor", function () {
    async function deployArgsBase() {
      const [contratante, prestador, arbitragem] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("Mock USD", "mUSD", 6);
      await token.waitForDeployment();

      return {
        contratante: contratante.address,
        prestador: prestador.address,
        v: ethers.parseUnits("100", 6),
        tauAceite: 1n,
        tauFinanc: 2n,
        tauExec: 3n,
        deltaTInsp: 4n,
        cidSpec: "cid",
        token: await token.getAddress(),
        arbitragem: arbitragem.address,
      };
    }

    it("reverte com EnderecoInvalido se αc for o endereço zero", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          ethers.ZeroAddress,
          a.prestador,
          a.v,
          a.tauAceite,
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          a.arbitragem
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "EnderecoInvalido");
    });

    it("reverte com EnderecoInvalido se αp for o endereço zero", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          ethers.ZeroAddress,
          a.v,
          a.tauAceite,
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          a.arbitragem
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "EnderecoInvalido");
    });

    it("reverte com EnderecoInvalido se a arbitragem for o endereço zero", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          a.prestador,
          a.v,
          a.tauAceite,
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "EnderecoInvalido");
    });

    it("reverte com EnderecoInvalido se o token for o endereço zero", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          a.prestador,
          a.v,
          a.tauAceite,
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          ethers.ZeroAddress,
          a.arbitragem
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "EnderecoInvalido");
    });

    it("reverte com ValorInvalido se v for zero", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          a.prestador,
          0n,
          a.tauAceite,
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          a.arbitragem
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "ValorInvalido");
    });

    it("reverte com PrazosInvalidos se τ_aceite >= τ_financ", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          a.prestador,
          a.v,
          a.tauFinanc, // τ_aceite == τ_financ (viola <)
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          a.arbitragem
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "PrazosInvalidos");
    });

    it("reverte com PrazosInvalidos se τ_financ >= τ_exec", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          a.prestador,
          a.v,
          a.tauAceite,
          a.tauExec, // τ_financ == τ_exec (viola <)
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          a.arbitragem
        )
      ).to.be.revertedWithCustomError(MellowProtocol, "PrazosInvalidos");
    });

    it("aceita τ_aceite < τ_financ < τ_exec (caminho feliz da validação)", async function () {
      const a = await deployArgsBase();
      const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
      await expect(
        MellowProtocol.deploy(
          a.contratante,
          a.prestador,
          a.v,
          a.tauAceite,
          a.tauFinanc,
          a.tauExec,
          a.deltaTInsp,
          a.cidSpec,
          a.token,
          a.arbitragem
        )
      ).to.not.be.reverted;
    });
  });
});

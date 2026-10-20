import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// Verifica que MellowProtocolClonable + MellowProtocolCloneFactory
/// resolvem corretamente a tensão de design documentada em
/// RELATORIO_EXPERIMENTOS.md (immutable vs. EIP-1167 clone): cada clone
/// criado via `cloneWithImmutableArgs` deve se comportar como uma
/// instância independente, com seu próprio vetor P, preservando S1
/// (integridade do saldo) e S2 (unicidade do destinatário) individualmente
/// por clone — não apenas no MellowProtocol.sol original.
describe("MellowProtocolClonable — correção funcional e custo de deploy (EIP-1167)", function () {
  async function deployFactory() {
    const Factory = await ethers.getContractFactory("MellowProtocolCloneFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    return factory;
  }

  async function criarArgsPadrao(tokenAddr: string, contratante: string, prestador: string, arbitragem: string) {
    const decimals = 6;
    const v = ethers.parseUnits("1000", decimals);
    const agora = await time.latest();
    return {
      contratante,
      prestador,
      v,
      tauAceite: agora + 3 * 24 * 60 * 60,
      tauFinanc: agora + 6 * 24 * 60 * 60,
      tauExec: agora + 20 * 24 * 60 * 60,
      deltaTInsp: 5 * 24 * 60 * 60,
      cidSpec: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      token: tokenAddr,
      arbitragem,
    };
  }

  it("clone funcional: executa o ciclo nominal completo com P próprio e preserva S1/S2", async function () {
    const [contratante, prestador, arbitragem] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USD", "mUSD", 6);
    await token.waitForDeployment();

    const factory = await deployFactory();
    const args = await criarArgsPadrao(await token.getAddress(), contratante.address, prestador.address, arbitragem.address);
    await token.mint(contratante.address, args.v);

    const tx = await factory.criarInstancia(
      args.contratante,
      args.prestador,
      args.v,
      args.tauAceite,
      args.tauFinanc,
      args.tauExec,
      args.deltaTInsp,
      args.cidSpec,
      args.token,
      args.arbitragem
    );
    const receipt = await tx.wait();
    const evento = receipt!.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "InstanciaCriada");
    const instanciaAddr = evento!.args[0] as string;

    const clone = await ethers.getContractAt("MellowProtocolClonable", instanciaAddr);

    // Vetor P decodificado corretamente a partir dos argumentos imutáveis do clone.
    const p = await clone.parametros();
    expect(p.contratante).to.equal(contratante.address);
    expect(p.prestador).to.equal(prestador.address);
    expect(p.v).to.equal(args.v);
    expect(p.cidSpec).to.equal(args.cidSpec);

    await token.connect(contratante).approve(instanciaAddr, args.v);

    // Ciclo nominal sigma1->sigma5 sobre o CLONE.
    await clone.connect(prestador).aceitar();
    await clone.connect(contratante).financiar();
    expect(await token.balanceOf(instanciaAddr)).to.equal(args.v); // S1 sobre o clone
    await clone.connect(prestador).iniciarExecucao();
    await clone.connect(prestador).confirmarEntrega(["cid-clone"]);
    await clone.connect(contratante).aprovarPagamento();

    expect(await clone.estado()).to.equal(6n); // CONCLUIDO
    expect(await token.balanceOf(instanciaAddr)).to.equal(0n); // S1: saldo final zero
    expect(await token.balanceOf(prestador.address)).to.equal(args.v); // S2: destinatário único correto
  });

  it("dois clones da mesma implementação têm P INDEPENDENTES (resolve a tensão immutable-vs-clone)", async function () {
    const [c1, p1, arb, c2, p2] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USD", "mUSD", 6);
    await token.waitForDeployment();
    const factory = await deployFactory();

    const argsA = await criarArgsPadrao(await token.getAddress(), c1.address, p1.address, arb.address);
    const argsB = { ...argsA, contratante: c2.address, prestador: p2.address, v: ethers.parseUnits("500", 6) };

    const txA = await factory.criarInstancia(
      argsA.contratante, argsA.prestador, argsA.v, argsA.tauAceite, argsA.tauFinanc, argsA.tauExec,
      argsA.deltaTInsp, argsA.cidSpec, argsA.token, argsA.arbitragem
    );
    const rA = await txA.wait();
    const instA = rA!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "InstanciaCriada")!.args[0];

    const txB = await factory.criarInstancia(
      argsB.contratante, argsB.prestador, argsB.v, argsB.tauAceite, argsB.tauFinanc, argsB.tauExec,
      argsB.deltaTInsp, argsB.cidSpec, argsB.token, argsB.arbitragem
    );
    const rB = await txB.wait();
    const instB = rB!.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "InstanciaCriada")!.args[0];

    const cloneA = await ethers.getContractAt("MellowProtocolClonable", instA);
    const cloneB = await ethers.getContractAt("MellowProtocolClonable", instB);

    const pA = await cloneA.parametros();
    const pB = await cloneB.parametros();

    expect(pA.contratante).to.equal(c1.address);
    expect(pB.contratante).to.equal(c2.address);
    expect(pA.v).to.equal(argsA.v);
    expect(pB.v).to.equal(argsB.v);
    expect(pA.v).to.not.equal(pB.v); // prova direta de que NÃO compartilham P
  });

  it("mede o custo de deploy: factory, clone naive (referência) e clone funcional (cloneWithImmutableArgs)", async function () {
    const [contratante, prestador, arbitragem] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USD", "mUSD", 6);
    await token.waitForDeployment();

    const Factory = await ethers.getContractFactory("MellowProtocolCloneFactory");
    const factoryDeployTx = await Factory.deploy();
    await factoryDeployTx.waitForDeployment();
    const factoryDeployReceipt = await factoryDeployTx.deploymentTransaction()!.wait();

    const args = await criarArgsPadrao(await token.getAddress(), contratante.address, prestador.address, arbitragem.address);

    const txNaive = await factoryDeployTx.criarInstanciaNaiveSemArgumentos();
    const rNaive = await txNaive.wait();

    const txReal = await factoryDeployTx.criarInstancia(
      args.contratante, args.prestador, args.v, args.tauAceite, args.tauFinanc, args.tauExec,
      args.deltaTInsp, args.cidSpec, args.token, args.arbitragem
    );
    const rReal = await txReal.wait();

    console.log("\n=== Custos de deploy medidos (receipt real, EIP-1167) ===");
    console.log("Factory (inclui 1x deploy da implementação):", factoryDeployReceipt!.gasUsed.toString());
    console.log("Clones.clone (naive, sem args — referência, NÃO funcional):", rNaive!.gasUsed.toString());
    console.log("Clones.cloneWithImmutableArgs (funcional, com P completo):", rReal!.gasUsed.toString());

    // Ambos devem ser drasticamente mais baratos que o deploy completo do
    // MellowProtocol.sol original (~1 607 696 gás, medido em scripts/medirGasReal.ts).
    expect(rNaive!.gasUsed).to.be.lessThan(200000n);
    expect(rReal!.gasUsed).to.be.lessThan(300000n);
  });
});

import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

async function deploy(cidSpec: string) {
  const [contratante, prestador, arbitragem] = await ethers.getSigners();
  const decimals = 6;
  const valorServico = ethers.parseUnits("1000", decimals);

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("Mock USD", "mUSD", decimals);
  await token.waitForDeployment();
  await token.mint(contratante.address, valorServico);

  const agora = await time.latest();
  const tauAceite = agora + 3 * 24 * 60 * 60;
  const tauFinanc = agora + 6 * 24 * 60 * 60;
  const tauExec = agora + 20 * 24 * 60 * 60;
  const deltaTInsp = 5 * 24 * 60 * 60;

  const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
  const deployTx = await MellowProtocol.deploy(
    contratante.address,
    prestador.address,
    valorServico,
    tauAceite,
    tauFinanc,
    tauExec,
    deltaTInsp,
    cidSpec,
    await token.getAddress(),
    arbitragem.address
  );
  await deployTx.waitForDeployment();
  const deployReceipt = await deployTx.deploymentTransaction()!.wait();

  await token.connect(contratante).approve(await deployTx.getAddress(), valorServico);

  return { mellow: deployTx, token, contratante, prestador, arbitragem, valorServico, deployGas: deployReceipt!.gasUsed };
}

async function gasDe(txPromise: Promise<any>): Promise<bigint> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return receipt.gasUsed as bigint;
}

async function main() {
  const cidSpecReal = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"; // mesma usada em test/fixtures.ts

  console.log("=== Deploy (mesma cidSpec de fixtures.ts) ===");
  const d0 = await deploy(cidSpecReal);
  console.log("Deploy gasUsed (receipt real):", d0.deployGas.toString());

  console.log("\n=== Ciclo nominal sigma1->sigma5 (receipts individuais) ===");
  {
    const { mellow, contratante, prestador } = await deploy(cidSpecReal);
    const g1 = await gasDe(mellow.connect(prestador).aceitar());
    const g2 = await gasDe(mellow.connect(contratante).financiar());
    const g3 = await gasDe(mellow.connect(prestador).iniciarExecucao());
    const g4 = await gasDe(mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]));
    const g5 = await gasDe(mellow.connect(contratante).aprovarPagamento());
    const total = g1 + g2 + g3 + g4 + g5;
    console.log({ aceitar: g1.toString(), financiar: g2.toString(), iniciarExecucao: g3.toString(), confirmarEntrega: g4.toString(), aprovarPagamento: g5.toString() });
    console.log("TOTAL ciclo nominal:", total.toString());
  }

  console.log("\n=== Ciclo com disputa — executarDecisao(0) (1 transfer, so contratante) ===");
  {
    const { mellow, contratante, prestador, arbitragem } = await deploy(cidSpecReal);
    const g1 = await gasDe(mellow.connect(prestador).aceitar());
    const g2 = await gasDe(mellow.connect(contratante).financiar());
    const g3 = await gasDe(mellow.connect(prestador).iniciarExecucao());
    const g4 = await gasDe(mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]));
    const g6 = await gasDe(mellow.connect(contratante).abrirDisputa(["cid-disputa"]));
    const g8 = await gasDe(mellow.connect(arbitragem).executarDecisao(0n));
    const total = g1 + g2 + g3 + g4 + g6 + g8;
    console.log({ executarDecisao_valor0: g8.toString() });
    console.log("TOTAL ciclo disputa (valor=0):", total.toString());
  }

  console.log("\n=== Ciclo com disputa — executarDecisao(v) (1 transfer, tudo p/ prestador) ===");
  {
    const { mellow, contratante, prestador, arbitragem, valorServico } = await deploy(cidSpecReal);
    const g1 = await gasDe(mellow.connect(prestador).aceitar());
    const g2 = await gasDe(mellow.connect(contratante).financiar());
    const g3 = await gasDe(mellow.connect(prestador).iniciarExecucao());
    const g4 = await gasDe(mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]));
    const g6 = await gasDe(mellow.connect(contratante).abrirDisputa(["cid-disputa"]));
    const g8 = await gasDe(mellow.connect(arbitragem).executarDecisao(valorServico));
    const total = g1 + g2 + g3 + g4 + g6 + g8;
    console.log({ executarDecisao_valorTotal: g8.toString() });
    console.log("TOTAL ciclo disputa (valor=v):", total.toString());
  }

  console.log("\n=== Ciclo com disputa — executarDecisao(v/4) (2 transfers, parcial — PIOR CASO esperado) ===");
  {
    const { mellow, contratante, prestador, arbitragem, valorServico } = await deploy(cidSpecReal);
    const g1 = await gasDe(mellow.connect(prestador).aceitar());
    const g2 = await gasDe(mellow.connect(contratante).financiar());
    const g3 = await gasDe(mellow.connect(prestador).iniciarExecucao());
    const g4 = await gasDe(mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]));
    const g6 = await gasDe(mellow.connect(contratante).abrirDisputa(["cid-disputa"]));
    const g8 = await gasDe(mellow.connect(arbitragem).executarDecisao(valorServico / 4n));
    const total = g1 + g2 + g3 + g4 + g6 + g8;
    console.log({ abrirDisputa: g6.toString(), executarDecisao_parcial: g8.toString() });
    console.log("TOTAL ciclo disputa (parcial):", total.toString());
  }

  console.log("\n=== Ciclo via watchdog Delta t4 (sigma1-4, acionarWatchdog libera fundos) ===");
  {
    const { mellow, token, contratante, prestador } = await deploy(cidSpecReal);
    const g1 = await gasDe(mellow.connect(prestador).aceitar());
    const g2 = await gasDe(mellow.connect(contratante).financiar());
    const g3 = await gasDe(mellow.connect(prestador).iniciarExecucao());
    const g4 = await gasDe(mellow.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]));
    const deltaTInsp = Number(await mellow.deltaTInsp());
    const tauEnt = await mellow.tauEnt();
    await time.increaseTo(tauEnt + BigInt(deltaTInsp) + 1n);
    const g7 = await gasDe(mellow.connect(contratante).acionarWatchdog());
    const total = g1 + g2 + g3 + g4 + g7;
    console.log({ acionarWatchdog_delta4: g7.toString() });
    console.log("TOTAL ciclo watchdog Δt4:", total.toString());
  }

  console.log("\n=== Evidências no formato CIDv1 (59 caracteres) em σ4 e σ6 ===");
  {
    const cidV1 = cidSpecReal;
    const a = await deploy(cidSpecReal);
    const g1 = await gasDe(a.mellow.connect(a.prestador).aceitar());
    const g2 = await gasDe(a.mellow.connect(a.contratante).financiar());
    const g3 = await gasDe(a.mellow.connect(a.prestador).iniciarExecucao());
    const g4 = await gasDe(a.mellow.connect(a.prestador).confirmarEntrega([cidV1]));
    const g5 = await gasDe(a.mellow.connect(a.contratante).aprovarPagamento());
    console.log({ confirmarEntrega_CIDv1: g4.toString() });
    console.log("TOTAL ciclo nominal (CIDv1):", (g1 + g2 + g3 + g4 + g5).toString());

    const b = await deploy(cidSpecReal);
    const h1 = await gasDe(b.mellow.connect(b.prestador).aceitar());
    const h2 = await gasDe(b.mellow.connect(b.contratante).financiar());
    const h3 = await gasDe(b.mellow.connect(b.prestador).iniciarExecucao());
    const h4 = await gasDe(b.mellow.connect(b.prestador).confirmarEntrega([cidV1]));
    const h6 = await gasDe(b.mellow.connect(b.contratante).abrirDisputa([cidV1]));
    const h8 = await gasDe(b.mellow.connect(b.arbitragem).executarDecisao(b.valorServico / 4n));
    console.log({ abrirDisputa_CIDv1: h6.toString() });
    console.log("TOTAL ciclo disputa parcial (CIDv1):", (h1 + h2 + h3 + h4 + h6 + h8).toString());
  }

  console.log("\n=== approve do token pelo contratante (fora de Σ, prévio a σ2) ===");
  {
    const [contratante] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USD", "mUSD", 6);
    await token.mint(contratante.address, ethers.parseUnits("1000", 6));
    const destino = ethers.Wallet.createRandom().address;
    const gAp = await gasDe(token.connect(contratante).approve(destino, ethers.parseUnits("1000", 6)));
    console.log("approve (allowance de zero para v):", gAp.toString());
  }

  console.log("\n=== Variante experimental clonável (MellowProtocolClonable via fábrica) ===");
  {
    const [contratante, prestador, arbitragem] = await ethers.getSigners();
    const valorServico = ethers.parseUnits("1000", 6);
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USD", "mUSD", 6);
    const fabrica = await (await ethers.getContractFactory("MellowProtocolCloneFactory")).deploy();

    async function novoClone() {
      await token.mint(contratante.address, valorServico);
      const agora = await time.latest();
      const tx = await fabrica.criarInstancia(
        contratante.address, prestador.address, valorServico,
        agora + 3 * 24 * 60 * 60, agora + 6 * 24 * 60 * 60, agora + 20 * 24 * 60 * 60, 5 * 24 * 60 * 60,
        cidSpecReal, await token.getAddress(), arbitragem.address
      );
      const recibo = await tx.wait();
      const ev = recibo!.logs
        .map((l: any) => { try { return fabrica.interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === "InstanciaCriada");
      const clone = await ethers.getContractAt("MellowProtocolClonable", ev!.args[0] as string);
      await token.connect(contratante).approve(await clone.getAddress(), valorServico);
      return { clone, criacao: recibo!.gasUsed as bigint };
    }

    const naive = (await (await fabrica.criarInstanciaNaiveSemArgumentos()).wait())!.gasUsed;
    console.log("Clones.clone (naive, NAO funcional):", naive.toString());

    const a = await novoClone();
    console.log("Clones.cloneWithImmutableArgs (funcional):", a.criacao.toString());
    const g1 = await gasDe(a.clone.connect(prestador).aceitar());
    const g2 = await gasDe(a.clone.connect(contratante).financiar());
    const g3 = await gasDe(a.clone.connect(prestador).iniciarExecucao());
    const g4 = await gasDe(a.clone.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]));
    const g5 = await gasDe(a.clone.connect(contratante).aprovarPagamento());
    console.log({ aceitar: g1.toString(), financiar: g2.toString(), iniciarExecucao: g3.toString(), confirmarEntrega: g4.toString(), aprovarPagamento: g5.toString() });
    console.log("TOTAL ciclo nominal sobre o clone:", (g1 + g2 + g3 + g4 + g5).toString());

    const b = await novoClone();
    await b.clone.connect(prestador).aceitar();
    await b.clone.connect(contratante).financiar();
    await b.clone.connect(prestador).iniciarExecucao();
    await b.clone.connect(prestador).confirmarEntrega(["bafybeih_entrega_cid_1"]);
    const g6 = await gasDe(b.clone.connect(contratante).abrirDisputa(["cid-disputa"]));
    const g8 = await gasDe(b.clone.connect(arbitragem).executarDecisao(valorServico / 4n));
    console.log({ abrirDisputa: g6.toString(), executarDecisao_parcial: g8.toString() });
    console.log("TOTAL ciclo disputa (parcial) sobre o clone:", (g1 + g2 + g3 + g4 + g6 + g8).toString());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

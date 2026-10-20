/// Ciclo nominal e ciclo com disputa na rede de teste Polygon Amoy (chainId 80002).
///
/// Não executado no ambiente da revisão (sem acesso à rede). Pré-requisitos:
///   AMOY_RPC_URL                  URL de um nó RPC da Amoy
///   AMOY_PK_CONTRATANTE           chave privada do contratante (com ~0,3 POL de teste; repassa o gás aos demais)
///   AMOY_PK_PRESTADOR             chave privada do prestador
///   AMOY_PK_ARBITRO               chave privada do árbitro simulado
/// Execução:
///   set -a; source .env.amoy; set +a; npx hardhat run scripts/cicloAmoy.ts --network amoy
/// Saída: scripts/out/cicloAmoy.json, com hash, bloco, gasUsed e effectiveGasPrice
/// de cada transação, para comparação com as medições da rede local (Tabela de gás
/// por função do Capítulo 4).
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

type Registro = { etapa: string; hash: string; bloco: number; gasUsed: string; effectiveGasPrice: string };

async function main() {
  if (network.name !== "amoy") throw new Error("Use --network amoy");
  const [contratante, prestador, arbitro] = await ethers.getSigners();
  const regs: Registro[] = [];
  const reg = async (etapa: string, txp: Promise<any>) => {
    const tx = await txp;
    const r = await tx.wait();
    regs.push({ etapa, hash: r.hash, bloco: r.blockNumber, gasUsed: r.gasUsed.toString(), effectiveGasPrice: r.gasPrice.toString() });
    console.log(`${etapa}: gas ${r.gasUsed} @ ${ethers.formatUnits(r.gasPrice, "gwei")} Gwei (${r.hash})`);
  };

  // Só o contratante precisa receber POL da faucet; ele repassa o gás de prestador e árbitro.
  const minimo = ethers.parseEther("0.03");
  for (const s of [prestador, arbitro]) {
    const saldo = await ethers.provider.getBalance(s.address);
    if (saldo < minimo) await (await contratante.sendTransaction({ to: s.address, value: minimo - saldo })).wait();
  }
  console.log(`contratante ${contratante.address}: ${ethers.formatEther(await ethers.provider.getBalance(contratante.address))} POL`);

  const decimals = 6;
  const v = ethers.parseUnits("200", decimals);
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"; // CIDv1, 59 caracteres

  const Token = await ethers.getContractFactory("MockERC20", contratante);
  const token = await Token.deploy("Mock USD", "mUSD", decimals);
  await token.waitForDeployment();
  await reg("mint", token.mint(contratante.address, 2n * v));

  const Mellow = await ethers.getContractFactory("MellowProtocol", contratante);
  for (const ciclo of ["nominal", "disputa"] as const) {
    const bloco = await ethers.provider.getBlock("latest");
    const agora = bloco!.timestamp;
    const m = await Mellow.deploy(
      contratante.address, prestador.address, v,
      agora + 3600, agora + 7200, agora + 86400, 3600,
      cid, await token.getAddress(), arbitro.address
    );
    const rd = await m.deploymentTransaction()!.wait();
    regs.push({ etapa: `${ciclo}:deploy`, hash: rd!.hash, bloco: rd!.blockNumber, gasUsed: rd!.gasUsed.toString(), effectiveGasPrice: rd!.gasPrice.toString() });
    const addr = await m.getAddress();
    await reg(`${ciclo}:approve`, token.connect(contratante).approve(addr, v));
    await reg(`${ciclo}:σ1 aceitar`, m.connect(prestador).aceitar());
    await reg(`${ciclo}:σ2 financiar`, m.connect(contratante).financiar());
    await reg(`${ciclo}:σ3 iniciarExecucao`, m.connect(prestador).iniciarExecucao());
    await reg(`${ciclo}:σ4 confirmarEntrega`, m.connect(prestador).confirmarEntrega([cid]));
    if (ciclo === "nominal") {
      await reg(`${ciclo}:σ5 aprovarPagamento`, m.connect(contratante).aprovarPagamento());
    } else {
      await reg(`${ciclo}:σ6 abrirDisputa`, m.connect(contratante).abrirDisputa([cid]));
      await reg(`${ciclo}:σ8 executarDecisao`, m.connect(arbitro).executarDecisao(v * 3n / 10n));
    }
    const saldo = await token.balanceOf(addr);
    console.log(`${ciclo}: estado ${await m.estado()}, saldo final ${saldo}`);
    if (saldo !== 0n) throw new Error("saldo residual: S1 violada");
  }

  const out = path.join(__dirname, "out", "cicloAmoy.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ rede: "amoy", chainId: 80002, data: new Date().toISOString(), regs }, null, 2));
  console.log(`registros em ${out}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

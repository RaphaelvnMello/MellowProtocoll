import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/// Fixture padrão de deploy, reutilizada por todas as suítes de teste
/// (nominal, accessControl, watchdog, reentrancy). Segue o roteiro: token
/// mock ERC-20 + approve prévio do contratante, parâmetros P completos.
export async function deployMellowProtocolFixture() {
  const [contratante, prestador, arbitragem, outro] = await ethers.getSigners();

  const decimals = 6;
  const valorServico = ethers.parseUnits("1000", decimals); // v

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("Mock USD", "mUSD", decimals);
  await token.waitForDeployment();

  await token.mint(contratante.address, valorServico);
  await token.mint(outro.address, valorServico);

  const agora = await time.latest();
  const tauAceite = agora + 3 * 24 * 60 * 60; // +3 dias
  const tauFinanc = agora + 6 * 24 * 60 * 60; // +6 dias
  const tauExec = agora + 20 * 24 * 60 * 60; // +20 dias
  const deltaTInsp = 5 * 24 * 60 * 60; // 5 dias, intervalo relativo
  const cidSpec = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  const MellowProtocol = await ethers.getContractFactory("MellowProtocol");
  const mellow = await MellowProtocol.deploy(
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
  await mellow.waitForDeployment();

  await token.connect(contratante).approve(await mellow.getAddress(), valorServico);

  return {
    mellow,
    token,
    contratante,
    prestador,
    arbitragem,
    outro,
    valorServico,
    tauAceite,
    tauFinanc,
    tauExec,
    deltaTInsp,
    cidSpec,
    decimals,
  };
}

/// Avança o estado até EM_EXECUCAO via σ1, σ2, σ3 (encadeamento comum a
/// várias suítes). Assume `approve` já concedido pela fixture acima.
export async function avancarAteEmExecucao(ctx: Awaited<ReturnType<typeof deployMellowProtocolFixture>>) {
  const { mellow, prestador, contratante } = ctx;
  await mellow.connect(prestador).aceitar();
  await mellow.connect(contratante).financiar();
  await mellow.connect(prestador).iniciarExecucao();
}

/// Avança o estado até ENTREGUE via σ1, σ2, σ3, σ4.
export async function avancarAteEntregue(
  ctx: Awaited<ReturnType<typeof deployMellowProtocolFixture>>,
  cids: string[] = ["bafybeih_entrega_cid_1"]
) {
  await avancarAteEmExecucao(ctx);
  await ctx.mellow.connect(ctx.prestador).confirmarEntrega(cids);
}

/// Avança o estado até EM_DISPUTA via σ1, σ2, σ3, σ4, σ6.
export async function avancarAteEmDisputa(
  ctx: Awaited<ReturnType<typeof deployMellowProtocolFixture>>,
  cids: string[] = ["bafybeih_disputa_cid_1"]
) {
  await avancarAteEntregue(ctx);
  await ctx.mellow.connect(ctx.contratante).abrirDisputa(cids);
}

/// Avança o estado até CONCLUIDO via σ1, σ2, σ3, σ4, σ5 (caminho nominal).
export async function avancarAteConcluido(ctx: Awaited<ReturnType<typeof deployMellowProtocolFixture>>) {
  await avancarAteEntregue(ctx);
  await ctx.mellow.connect(ctx.contratante).aprovarPagamento();
}

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/// Aplica à variante experimental MellowProtocolClonable (instanciada pela
/// fábrica via Clones.cloneWithImmutableArgs) as mesmas verificações exigidas
/// do contrato principal: varredura das 52 células ∅ da matriz δ, as 12
/// transições definidas (incluindo os quatro watchdogs), controle de acesso
/// por ator, validação dos parâmetros na fábrica, depósito incompleto (S1) e
/// bloqueio de reentrância nas três funções de liquidação e no depósito (σ2).
///
/// Diferença de implementação em relação a MellowProtocol.sol: no clone, a
/// guarda de estado (`emEstado`) é avaliada antes da guarda de ator, que fica
/// no corpo da função. Por isso a matriz é exercida com o ator correto, como
/// em matrizEstados.test.ts, e o controle de acesso é testado em estados nos
/// quais δ está definido.

const UM_DIA = 24 * 60 * 60;
const CID_SPEC = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

async function criarClone(fabrica: any, args: any[]) {
  const recibo = await (await fabrica.criarInstancia(...args)).wait();
  const ev = recibo!.logs
    .map((l: any) => {
      try {
        return fabrica.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: any) => e?.name === "InstanciaCriada");
  return ethers.getContractAt("MellowProtocolClonable", ev!.args[0] as string);
}

async function cloneFixture() {
  const [contratante, prestador, arbitragem, outro] = await ethers.getSigners();
  const valorServico = ethers.parseUnits("1000", 6);
  const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USD", "mUSD", 6);
  const fabrica = await (await ethers.getContractFactory("MellowProtocolCloneFactory")).deploy();
  await token.mint(contratante.address, valorServico);

  const agora = await time.latest();
  const tauAceite = agora + 3 * UM_DIA;
  const tauFinanc = agora + 6 * UM_DIA;
  const tauExec = agora + 20 * UM_DIA;
  const deltaTInsp = 5 * UM_DIA;

  const mellow = await criarClone(fabrica, [
    contratante.address, prestador.address, valorServico, tauAceite, tauFinanc, tauExec, deltaTInsp,
    CID_SPEC, await token.getAddress(), arbitragem.address,
  ]);
  await token.connect(contratante).approve(await mellow.getAddress(), valorServico);
  return { mellow, token, fabrica, contratante, prestador, arbitragem, outro, valorServico, tauAceite, tauFinanc, tauExec, deltaTInsp };
}

type Ctx = Awaited<ReturnType<typeof cloneFixture>>;

async function ateEmExecucao(c: Ctx) {
  await c.mellow.connect(c.prestador).aceitar();
  await c.mellow.connect(c.contratante).financiar();
  await c.mellow.connect(c.prestador).iniciarExecucao();
}
async function ateEntregue(c: Ctx) {
  await ateEmExecucao(c);
  await c.mellow.connect(c.prestador).confirmarEntrega(["cid-entrega"]);
}

describe("MellowProtocolClonable — conformidade com a especificação", function () {
  describe("matriz δ: 52 células ∅", function () {
    const SIGMAS = [
      "aceitar", "financiar", "iniciarExecucao", "confirmarEntrega",
      "aprovarPagamento", "abrirDisputa", "acionarWatchdog", "executarDecisao",
    ] as const;
    type Sigma = (typeof SIGMAS)[number];

    const chamar = (c: Ctx): Record<Sigma, () => Promise<unknown>> => ({
      aceitar: () => c.mellow.connect(c.prestador).aceitar(),
      financiar: () => c.mellow.connect(c.contratante).financiar(),
      iniciarExecucao: () => c.mellow.connect(c.prestador).iniciarExecucao(),
      confirmarEntrega: () => c.mellow.connect(c.prestador).confirmarEntrega(["cid"]),
      aprovarPagamento: () => c.mellow.connect(c.contratante).aprovarPagamento(),
      abrirDisputa: () => c.mellow.connect(c.contratante).abrirDisputa(["cid"]),
      acionarWatchdog: () => c.mellow.connect(c.outro).acionarWatchdog(),
      executarDecisao: () => c.mellow.connect(c.arbitragem).executarDecisao(0n),
    });

    const CASOS: { estado: string; validos: Sigma[]; chegar: (c: Ctx) => Promise<void> }[] = [
      { estado: "CRIADO", validos: ["aceitar", "acionarWatchdog"], chegar: async () => {} },
      { estado: "ACEITO", validos: ["financiar", "acionarWatchdog"], chegar: async (c) => { await c.mellow.connect(c.prestador).aceitar(); } },
      {
        estado: "FINANCIADO", validos: ["iniciarExecucao", "acionarWatchdog"],
        chegar: async (c) => { await c.mellow.connect(c.prestador).aceitar(); await c.mellow.connect(c.contratante).financiar(); },
      },
      { estado: "EM_EXECUCAO", validos: ["confirmarEntrega", "acionarWatchdog"], chegar: ateEmExecucao },
      { estado: "ENTREGUE", validos: ["aprovarPagamento", "abrirDisputa", "acionarWatchdog"], chegar: ateEntregue },
      {
        estado: "EM_DISPUTA", validos: ["executarDecisao"],
        chegar: async (c) => { await ateEntregue(c); await c.mellow.connect(c.contratante).abrirDisputa(["cid"]); },
      },
      {
        estado: "CONCLUIDO", validos: [],
        chegar: async (c) => { await ateEntregue(c); await c.mellow.connect(c.contratante).aprovarPagamento(); },
      },
      {
        estado: "CANCELADO", validos: [],
        chegar: async (c) => { await time.increaseTo(c.tauAceite + 1); await c.mellow.acionarWatchdog(); },
      },
    ];

    for (const caso of CASOS) {
      for (const sigma of SIGMAS.filter((s) => !caso.validos.includes(s))) {
        it(`δ(${caso.estado}, ${sigma}) = ∅ reverte com EstadoInvalido`, async function () {
          const c = await loadFixture(cloneFixture);
          await caso.chegar(c);
          await expect(chamar(c)[sigma]()).to.be.revertedWithCustomError(c.mellow, "EstadoInvalido");
        });
      }
    }

    it("a enumeração cobre 64 células (12 definidas + 52 ∅)", function () {
      expect(CASOS.length * SIGMAS.length).to.equal(64);
      expect(CASOS.reduce((a, c) => a + c.validos.length, 0)).to.equal(12);
    });
  });

  describe("12 transições definidas", function () {
    it("σ1→σ5: ciclo nominal, saldo final zero e pagamento ao prestador (S1, S2)", async function () {
      const c = await loadFixture(cloneFixture);
      await ateEntregue(c);
      await c.mellow.connect(c.contratante).aprovarPagamento();
      expect(await c.mellow.estado()).to.equal(6n);
      expect(await c.token.balanceOf(await c.mellow.getAddress())).to.equal(0n);
      expect(await c.token.balanceOf(c.prestador.address)).to.equal(c.valorServico);
    });

    it("σ6 e σ8 com decisão parcial: divide exatamente v entre as partes", async function () {
      const c = await loadFixture(cloneFixture);
      await ateEntregue(c);
      await c.mellow.connect(c.prestador).abrirDisputa(["cid-disputa"]);
      expect(await c.mellow.cidsEntrega()).to.deep.equal(["cid-entrega"]);
      expect(await c.mellow.cidsDisputa()).to.deep.equal(["cid-disputa"]);
      await c.mellow.connect(c.arbitragem).executarDecisao(c.valorServico / 4n);
      expect(await c.token.balanceOf(await c.mellow.getAddress())).to.equal(0n);
      expect(await c.token.balanceOf(c.prestador.address)).to.equal(c.valorServico / 4n);
      expect(await c.token.balanceOf(c.contratante.address)).to.equal(c.valorServico - c.valorServico / 4n);
    });

    it("σ8 com decisão integral ao contratante: devolve v ao contratante", async function () {
      const c = await loadFixture(cloneFixture);
      await ateEntregue(c);
      await c.mellow.connect(c.contratante).abrirDisputa(["cid"]);
      await c.mellow.connect(c.arbitragem).executarDecisao(0n);
      expect(await c.token.balanceOf(c.contratante.address)).to.equal(c.valorServico);
      expect(await c.token.balanceOf(c.prestador.address)).to.equal(0n);
    });

    it("σ7 por Δt1: CRIADO → CANCELADO somente após τ_aceite", async function () {
      const c = await loadFixture(cloneFixture);
      await expect(c.mellow.acionarWatchdog()).to.be.revertedWithCustomError(c.mellow, "PrazoNaoExpirado");
      await time.increaseTo(c.tauAceite + 1);
      await c.mellow.connect(c.outro).acionarWatchdog();
      expect(await c.mellow.estado()).to.equal(7n);
    });

    it("σ7 por Δt2: ACEITO → CANCELADO somente após τ_financ", async function () {
      const c = await loadFixture(cloneFixture);
      await c.mellow.connect(c.prestador).aceitar();
      await expect(c.mellow.acionarWatchdog()).to.be.revertedWithCustomError(c.mellow, "PrazoNaoExpirado");
      await time.increaseTo(c.tauFinanc + 1);
      await c.mellow.acionarWatchdog();
      expect(await c.mellow.estado()).to.equal(7n);
    });

    it("σ7 por Δt3: FINANCIADO → EM_DISPUTA após τ_exec, saldo mantido", async function () {
      const c = await loadFixture(cloneFixture);
      await c.mellow.connect(c.prestador).aceitar();
      await c.mellow.connect(c.contratante).financiar();
      await expect(c.mellow.acionarWatchdog()).to.be.revertedWithCustomError(c.mellow, "PrazoNaoExpirado");
      await time.increaseTo(c.tauExec + 1);
      await c.mellow.acionarWatchdog();
      expect(await c.mellow.estado()).to.equal(5n);
      expect(await c.token.balanceOf(await c.mellow.getAddress())).to.equal(c.valorServico);
    });

    it("σ7 por Δt3: EM_EXECUCAO → EM_DISPUTA após τ_exec", async function () {
      const c = await loadFixture(cloneFixture);
      await ateEmExecucao(c);
      await time.increaseTo(c.tauExec + 1);
      await c.mellow.acionarWatchdog();
      expect(await c.mellow.estado()).to.equal(5n);
    });

    it("σ7 por Δt4: ENTREGUE → CONCLUIDO após τ_ent + Δt_insp, liberando v ao prestador", async function () {
      const c = await loadFixture(cloneFixture);
      await ateEntregue(c);
      await expect(c.mellow.acionarWatchdog()).to.be.revertedWithCustomError(c.mellow, "PrazoNaoExpirado");
      await time.increaseTo((await c.mellow.tauEnt()) + BigInt(c.deltaTInsp) + 1n);
      await c.mellow.connect(c.outro).acionarWatchdog();
      expect(await c.mellow.estado()).to.equal(6n);
      expect(await c.token.balanceOf(c.prestador.address)).to.equal(c.valorServico);
    });
  });

  describe("controle de acesso por ator", function () {
    it("σ1, σ3 e σ4 exigem o prestador; σ2 e σ5 exigem o contratante", async function () {
      const c = await loadFixture(cloneFixture);
      await expect(c.mellow.connect(c.contratante).aceitar()).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
      await c.mellow.connect(c.prestador).aceitar();
      await expect(c.mellow.connect(c.prestador).financiar()).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
      await c.mellow.connect(c.contratante).financiar();
      await expect(c.mellow.connect(c.contratante).iniciarExecucao()).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
      await c.mellow.connect(c.prestador).iniciarExecucao();
      await expect(c.mellow.connect(c.outro).confirmarEntrega(["cid"])).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
      await c.mellow.connect(c.prestador).confirmarEntrega(["cid"]);
      await expect(c.mellow.connect(c.prestador).aprovarPagamento()).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
    });

    it("σ6 rejeita terceiros e σ8 aceita apenas o módulo de arbitragem", async function () {
      const c = await loadFixture(cloneFixture);
      await ateEntregue(c);
      await expect(c.mellow.connect(c.outro).abrirDisputa(["cid"])).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
      await c.mellow.connect(c.contratante).abrirDisputa(["cid"]);
      for (const ator of [c.contratante, c.prestador, c.outro]) {
        await expect(c.mellow.connect(ator).executarDecisao(0n)).to.be.revertedWithCustomError(c.mellow, "NaoAutorizado");
      }
      await expect(c.mellow.connect(c.arbitragem).executarDecisao(c.valorServico + 1n)).to.be.revertedWithCustomError(
        c.mellow, "ValorInvalido"
      );
    });
  });

  describe("validação de P na fábrica", function () {
    it("rejeita endereço zero, v = 0 e prazos fora de ordem", async function () {
      const c = await loadFixture(cloneFixture);
      const t = await time.latest();
      const base = [c.contratante.address, c.prestador.address, 1n, t + 10, t + 20, t + 30, 5, "cid", await c.token.getAddress(), c.arbitragem.address];
      const com = (i: number, v: unknown) => base.map((x, j) => (j === i ? v : x));
      await expect(c.fabrica.criarInstancia(...com(0, ethers.ZeroAddress))).to.be.revertedWithCustomError(c.fabrica, "EnderecoInvalido");
      for (const i of [1, 8, 9]) {
        await expect(c.fabrica.criarInstancia(...com(i, ethers.ZeroAddress))).to.be.revertedWithCustomError(c.fabrica, "EnderecoInvalido");
      }
      await expect(c.fabrica.criarInstancia(...com(2, 0n))).to.be.revertedWithCustomError(c.fabrica, "ValorInvalido");
      await expect(c.fabrica.criarInstancia(...com(4, t + 10))).to.be.revertedWithCustomError(c.fabrica, "PrazosInvalidos");
      await expect(c.fabrica.criarInstancia(...com(5, t + 20))).to.be.revertedWithCustomError(c.fabrica, "PrazosInvalidos");
    });
  });

  describe("cenários adversariais", function () {
    it("financiar() reverte com DepositoInvalido para token com taxa de transferência (S1)", async function () {
      const [contratante, prestador, arbitragem] = await ethers.getSigners();
      const v = ethers.parseUnits("1000", 6);
      const token = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy("Fee USD", "fUSD", 6, 100);
      await token.mint(contratante.address, v);
      const fabrica = await (await ethers.getContractFactory("MellowProtocolCloneFactory")).deploy();
      const t = await time.latest();
      const clone = await criarClone(fabrica, [
        contratante.address, prestador.address, v, t + 3 * UM_DIA, t + 6 * UM_DIA, t + 20 * UM_DIA, 5 * UM_DIA,
        "cid", await token.getAddress(), arbitragem.address,
      ]);
      await token.connect(contratante).approve(await clone.getAddress(), v);
      await clone.connect(prestador).aceitar();
      await expect(clone.connect(contratante).financiar()).to.be.revertedWithCustomError(clone, "DepositoInvalido");
      expect(await clone.estado()).to.equal(1n);
    });

    async function cloneComExploiter() {
      const [contratante, , arbitragem, outro] = await ethers.getSigners();
      const v = ethers.parseUnits("1000", 6);
      const token = await (await ethers.getContractFactory("MaliciousERC20")).deploy("Malicious USD", "mxUSD", 6);
      const exploiter = await (await ethers.getContractFactory("ReentrancyExploiter")).deploy();
      const exploiterAddr = await exploiter.getAddress();
      const fabrica = await (await ethers.getContractFactory("MellowProtocolCloneFactory")).deploy();
      const t = await time.latest();
      const clone = await criarClone(fabrica, [
        contratante.address, exploiterAddr, v, t + 3 * UM_DIA, t + 6 * UM_DIA, t + 20 * UM_DIA, 5 * UM_DIA,
        "cid", await token.getAddress(), arbitragem.address,
      ]);
      const cloneAddr = await clone.getAddress();
      await token.setGatilho(exploiterAddr);
      await token.mint(contratante.address, v);
      await token.connect(contratante).approve(cloneAddr, v);
      await exploiter.executar(cloneAddr, clone.interface.encodeFunctionData("aceitar"));
      await clone.connect(contratante).financiar();
      await exploiter.executar(cloneAddr, clone.interface.encodeFunctionData("iniciarExecucao"));
      await exploiter.executar(cloneAddr, clone.interface.encodeFunctionData("confirmarEntrega", [["cid"]]));
      return { clone, cloneAddr, exploiter, contratante, arbitragem, outro, v };
    }

    it("reentrada em σ5 é bloqueada", async function () {
      const x = await cloneComExploiter();
      await x.exploiter.configurarAtaque(x.cloneAddr, x.clone.interface.encodeFunctionData("aprovarPagamento"));
      await x.clone.connect(x.contratante).aprovarPagamento();
      expect(await x.exploiter.tentouReentrar()).to.equal(true);
      expect(await x.exploiter.reentradaBemSucedida()).to.equal(false);
    });

    it("reentrada em σ7 (Δt4) é bloqueada", async function () {
      const x = await cloneComExploiter();
      await x.exploiter.configurarAtaque(x.cloneAddr, x.clone.interface.encodeFunctionData("acionarWatchdog"));
      await time.increaseTo((await x.clone.tauEnt()) + BigInt(5 * UM_DIA) + 1n);
      await x.clone.connect(x.outro).acionarWatchdog();
      expect(await x.exploiter.tentouReentrar()).to.equal(true);
      expect(await x.exploiter.reentradaBemSucedida()).to.equal(false);
    });

    it("reentrada em σ7 durante σ2 (gancho do remetente) é bloqueada", async function () {
      const [, prestador, arbitragem] = await ethers.getSigners();
      const v = ethers.parseUnits("1000", 6);
      const token = await (await ethers.getContractFactory("MaliciousERC20")).deploy("Malicious USD", "mxUSD", 6);
      const exploiter = await (await ethers.getContractFactory("ReentrancyExploiter")).deploy();
      const exploiterAddr = await exploiter.getAddress();
      const fabrica = await (await ethers.getContractFactory("MellowProtocolCloneFactory")).deploy();
      const t = await time.latest();
      const clone = await criarClone(fabrica, [
        exploiterAddr, prestador.address, v, t + 3 * UM_DIA, t + 6 * UM_DIA, t + 20 * UM_DIA, 5 * UM_DIA,
        "cid", await token.getAddress(), arbitragem.address,
      ]);
      const cloneAddr = await clone.getAddress();
      await clone.connect(prestador).aceitar();
      await token.mint(exploiterAddr, v);
      await exploiter.executar(await token.getAddress(), token.interface.encodeFunctionData("approve", [cloneAddr, v]));
      await token.setGatilho(exploiterAddr);
      await time.increaseTo(t + 6 * UM_DIA + 1);
      await exploiter.configurarAtaque(cloneAddr, clone.interface.encodeFunctionData("acionarWatchdog"));
      await exploiter.executar(cloneAddr, clone.interface.encodeFunctionData("financiar"));
      expect(await exploiter.tentouReentrar()).to.equal(true);
      expect(await exploiter.reentradaBemSucedida()).to.equal(false);
      expect(await clone.estado()).to.equal(2n);
    });

    it("reentrada em σ2 durante σ2 (gancho do remetente) é bloqueada", async function () {
      const [, prestador, arbitragem] = await ethers.getSigners();
      const v = ethers.parseUnits("1000", 6);
      const token = await (await ethers.getContractFactory("MaliciousERC20")).deploy("Malicious USD", "mxUSD", 6);
      const exploiter = await (await ethers.getContractFactory("ReentrancyExploiter")).deploy();
      const exploiterAddr = await exploiter.getAddress();
      const fabrica = await (await ethers.getContractFactory("MellowProtocolCloneFactory")).deploy();
      const t = await time.latest();
      const clone = await criarClone(fabrica, [
        exploiterAddr, prestador.address, v, t + 3 * UM_DIA, t + 6 * UM_DIA, t + 20 * UM_DIA, 5 * UM_DIA,
        "cid", await token.getAddress(), arbitragem.address,
      ]);
      const cloneAddr = await clone.getAddress();
      await clone.connect(prestador).aceitar();
      await token.mint(exploiterAddr, v);
      await exploiter.executar(await token.getAddress(), token.interface.encodeFunctionData("approve", [cloneAddr, v]));
      await token.setGatilho(exploiterAddr);
      await time.increaseTo(t + 6 * UM_DIA + 1);
      await exploiter.configurarAtaque(cloneAddr, clone.interface.encodeFunctionData("financiar"));
      await exploiter.executar(cloneAddr, clone.interface.encodeFunctionData("financiar"));
      expect(await exploiter.tentouReentrar()).to.equal(true);
      expect(await exploiter.reentradaBemSucedida()).to.equal(false);
      expect(await clone.estado()).to.equal(2n);
    });

    it("reentrada em σ8 é bloqueada", async function () {
      const x = await cloneComExploiter();
      await x.clone.connect(x.contratante).abrirDisputa(["cid"]);
      await x.exploiter.configurarAtaque(x.cloneAddr, x.clone.interface.encodeFunctionData("executarDecisao", [x.v]));
      await x.clone.connect(x.arbitragem).executarDecisao(x.v);
      expect(await x.exploiter.tentouReentrar()).to.equal(true);
      expect(await x.exploiter.reentradaBemSucedida()).to.equal(false);
    });
  });
});

// Traço de execução do cenário de demonstração (atividade 4 do DSR).
//
// Executa cinco ciclos sobre o acordo de referência do Cap. 4 e registra, a
// cada transação, o dia relativo à implantação, o ator, o evento de Σ, o
// estado resultante, os saldos (contrato, contratante, prestador), os eventos
// emitidos e o gás do recibo. Tentativas inválidas são registradas com o erro
// customizado retornado. Saída: tabela no console e JSON em
// scripts/out/tracoDemonstracao.json.
//
// Uso: npx hardhat run scripts/tracoDemonstracao.ts

import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

const DIA = 24 * 60 * 60;
const ESTADOS = ["CRIADO", "ACEITO", "FINANCIADO", "EM_EXECUCAO", "ENTREGUE", "EM_DISPUTA", "CONCLUIDO", "CANCELADO"];
const CID_SPEC = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

type Passo = {
  ciclo: string;
  dia: number;
  ator: string;
  chamada: string;
  resultado: string;
  estado: string;
  saldoContrato: string;
  saldoContratante: string;
  saldoPrestador: string;
  eventos: string[];
  gas: string;
};

async function montar() {
  const [contratante, prestador, arbitragem, terceiro] = await ethers.getSigners();
  const decimals = 6;
  const v = ethers.parseUnits("1000", decimals);

  const token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USD", "mUSD", decimals);
  await token.waitForDeployment();
  await token.mint(contratante.address, v);

  const t0 = await time.latest();
  const mellow = await (await ethers.getContractFactory("MellowProtocol")).deploy(
    contratante.address,
    prestador.address,
    v,
    t0 + 3 * DIA,
    t0 + 6 * DIA,
    t0 + 20 * DIA,
    5 * DIA,
    CID_SPEC,
    await token.getAddress(),
    arbitragem.address
  );
  await mellow.waitForDeployment();
  const atores: Record<string, any> = { contratante, prestador, arbitragem, terceiro };
  return { mellow, token, atores, t0, decimals };
}

async function main() {
  const passos: Passo[] = [];

  async function rodarCiclo(
    nome: string,
    roteiro: Array<{ dia: number; ator: string; chamada: string; fn: (m: any, a: any) => Promise<any> }>
  ) {
    const { mellow, token, atores, t0, decimals } = await montar();
    const addr = await mellow.getAddress();
    const fmt = (x: bigint) => ethers.formatUnits(x, decimals);

    async function registrar(dia: number, ator: string, chamada: string, resultado: string, eventos: string[], gas: string) {
      passos.push({
        ciclo: nome,
        dia,
        ator,
        chamada,
        resultado,
        estado: ESTADOS[Number(await mellow.estado())],
        saldoContrato: fmt(await token.balanceOf(addr)),
        saldoContratante: fmt(await token.balanceOf(atores.contratante.address)),
        saldoPrestador: fmt(await token.balanceOf(atores.prestador.address)),
        eventos,
        gas,
      });
    }

    await registrar(0, "contratante", "implantação", "ok", [], "-");

    for (const p of roteiro) {
      const alvo = t0 + Math.round(p.dia * DIA);
      const agora = await time.latest();
      if (alvo > agora) await time.increaseTo(alvo);
      try {
        const tx = await p.fn(mellow.connect(atores[p.ator]), { token, addr, atores });
        const rc = await tx.wait();
        const eventos = rc.logs
          .map((l: any) => {
            try {
              return mellow.interface.parseLog(l)?.name;
            } catch {
              return undefined;
            }
          })
          .filter((x: any) => x);
        await registrar(p.dia, p.ator, p.chamada, "ok", eventos, rc.gasUsed.toString());
      } catch (e: any) {
        const bruto: string | undefined = typeof e?.data === "string" ? e.data : e?.data?.data;
        let erro: string = e?.revert?.name ?? "revert";
        if (erro === "revert" && bruto) {
          try {
            erro = mellow.interface.parseError(bruto)?.name ?? erro;
          } catch {
            /* mantém "revert" */
          }
        }
        if (erro === "revert") {
          const m = /custom error '([A-Za-z]+)/.exec(String(e?.message));
          if (m) erro = m[1];
        }
        await registrar(p.dia, p.ator, p.chamada, `revertida (${erro})`, [], "-");
      }
    }
  }

  // Ciclo A: disputa aberta pelo contratante e decisão parcial (60% ao prestador).
  await rodarCiclo("A: disputa e decisão parcial", [
    { dia: 0.01, ator: "contratante", chamada: "approve (fora de Σ)", fn: async (_m, c) => c.token.connect(c.atores.contratante).approve(c.addr, ethers.parseUnits("1000", 6)) },
    { dia: 1, ator: "prestador", chamada: "aceitar (σ1)", fn: (m) => m.aceitar() },
    { dia: 2, ator: "contratante", chamada: "financiar (σ2)", fn: (m) => m.financiar() },
    { dia: 3, ator: "prestador", chamada: "iniciarExecucao (σ3)", fn: (m) => m.iniciarExecucao() },
    { dia: 10, ator: "prestador", chamada: "confirmarEntrega (σ4)", fn: (m) => m.confirmarEntrega(["bafybeih_entrega_cid_1"]) },
    { dia: 12, ator: "contratante", chamada: "abrirDisputa (σ6)", fn: (m) => m.abrirDisputa(["cid-disputa"]) },
    { dia: 13, ator: "contratante", chamada: "aprovarPagamento (σ5)", fn: (m) => m.aprovarPagamento() },
    { dia: 18, ator: "terceiro", chamada: "acionarWatchdog (σ7)", fn: (m) => m.acionarWatchdog() },
    { dia: 19, ator: "terceiro", chamada: "executarDecisao (σ8)", fn: (m) => m.executarDecisao(ethers.parseUnits("600", 6)) },
    { dia: 20, ator: "arbitragem", chamada: "executarDecisao (σ8, 600)", fn: (m) => m.executarDecisao(ethers.parseUnits("600", 6)) },
  ]);

  // Ciclo B: silêncio do contratante após a entrega; liberação automática por Δt4.
  await rodarCiclo("B: liberação automática por Δt4", [
    { dia: 0.01, ator: "contratante", chamada: "approve (fora de Σ)", fn: async (_m, c) => c.token.connect(c.atores.contratante).approve(c.addr, ethers.parseUnits("1000", 6)) },
    { dia: 1, ator: "prestador", chamada: "aceitar (σ1)", fn: (m) => m.aceitar() },
    { dia: 2, ator: "contratante", chamada: "financiar (σ2)", fn: (m) => m.financiar() },
    { dia: 3, ator: "prestador", chamada: "iniciarExecucao (σ3)", fn: (m) => m.iniciarExecucao() },
    { dia: 10, ator: "prestador", chamada: "confirmarEntrega (σ4)", fn: (m) => m.confirmarEntrega(["bafybeih_entrega_cid_1"]) },
    { dia: 14, ator: "prestador", chamada: "acionarWatchdog (σ7)", fn: (m) => m.acionarWatchdog() },
    { dia: 15.01, ator: "prestador", chamada: "acionarWatchdog (σ7)", fn: (m) => m.acionarWatchdog() },
  ]);

  // Ciclo C: prestador não entrega até τ_exec; Δt3 leva a EM_DISPUTA e a arbitragem devolve tudo.
  await rodarCiclo("C: inexecução, Δt3 e devolução", [
    { dia: 0.01, ator: "contratante", chamada: "approve (fora de Σ)", fn: async (_m, c) => c.token.connect(c.atores.contratante).approve(c.addr, ethers.parseUnits("1000", 6)) },
    { dia: 1, ator: "prestador", chamada: "aceitar (σ1)", fn: (m) => m.aceitar() },
    { dia: 2, ator: "contratante", chamada: "financiar (σ2)", fn: (m) => m.financiar() },
    { dia: 3, ator: "prestador", chamada: "iniciarExecucao (σ3)", fn: (m) => m.iniciarExecucao() },
    { dia: 20.01, ator: "contratante", chamada: "acionarWatchdog (σ7)", fn: (m) => m.acionarWatchdog() },
    { dia: 25, ator: "arbitragem", chamada: "executarDecisao (σ8, 0)", fn: (m) => m.executarDecisao(0n) },
  ]);

  // Ciclo D: prestador não aceita até τ_aceite; Δt1 cancela sem movimentar fundos.
  await rodarCiclo("D: cancelamento por Δt1", [
    { dia: 3.01, ator: "contratante", chamada: "acionarWatchdog (σ7)", fn: (m) => m.acionarWatchdog() },
  ]);

  // Ciclo E: contratante não financia até τ_financ; Δt2 cancela sem movimentar fundos.
  await rodarCiclo("E: cancelamento por Δt2", [
    { dia: 1, ator: "prestador", chamada: "aceitar (σ1)", fn: (m) => m.aceitar() },
    { dia: 6.01, ator: "prestador", chamada: "acionarWatchdog (σ7)", fn: (m) => m.acionarWatchdog() },
  ]);

  for (const p of passos) {
    console.log(
      [p.ciclo, `d${p.dia}`, p.ator, p.chamada, p.resultado, p.estado, p.saldoContrato, p.saldoContratante, p.saldoPrestador, p.eventos.join("+") || "-", p.gas].join(" | ")
    );
  }
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "tracoDemonstracao.json"), JSON.stringify(passos, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

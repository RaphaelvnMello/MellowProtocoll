import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployMellowProtocolFixture } from "./fixtures";

/// Teste de propriedade (fuzzing com semente fixa) do invariante S1.
///
/// Cada campanha parte de uma implantação nova e executa uma sequência
/// aleatória de passos. Cada passo é uma das oito funções de Σ, invocada por
/// um ator sorteado entre {αc, αp, αa, terceiro}, ou uma transferência direta
/// do terceiro ao contrato (componente D do saldo real). Metade dos passos é
/// guiada para eventos habilitados, a fim de alcançar os estados profundos. Antes de cada passo,
/// o relógio avança por um intervalo sorteado, com preferência pelas
/// vizinhanças dos prazos (prazo − 1, prazo, prazo + 1), onde as guardas
/// estritas (t > τ) mudam de valor.
///
/// Um modelo de referência, escrito a partir da Tabela de transição e do
/// Quadro de watchdogs do Capítulo 3 (e não a partir do código Solidity),
/// prevê se cada chamada deve ser aceita ou revertida e o estado seguinte.
/// Após cada passo verifica-se:
///   (i)   aceitação/reversão observada = prevista pelo modelo (δ e guardas);
///   (ii)  estado on-chain = estado do modelo;
///   (iii) B(ρ) = 𝓕(s), com B(ρ) acumulado pelos efeitos e_in/e_out do modelo;
///   (iv)  saldo real do contrato b = B(ρ) + D;
///   (v)   o árbitro e o terceiro nunca recebem valor do contrato, e a soma
///         dos saldos das quatro contas e do contrato se conserva.
///
/// Parâmetros por variável de ambiente: FUZZ_SEED (padrão 20261009),
/// FUZZ_RUNS (padrão 300 campanhas) e FUZZ_STEPS (padrão 20 passos).

const SEED = Number(process.env.FUZZ_SEED ?? 20261009);
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const STEPS = Number(process.env.FUZZ_STEPS ?? 20);

enum S {
  CRIADO,
  ACEITO,
  FINANCIADO,
  EM_EXECUCAO,
  ENTREGUE,
  EM_DISPUTA,
  CONCLUIDO,
  CANCELADO,
}

// Gerador pseudoaleatório mulberry32 (determinístico, sem dependências).
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ator = "c" | "p" | "a" | "x";
type Acao = "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7" | "s8" | "D";

// 𝓕: valor custodiado esperado em cada estado (Capítulo 3).
function F(s: S, v: bigint): bigint {
  return s === S.FINANCIADO || s === S.EM_EXECUCAO || s === S.ENTREGUE || s === S.EM_DISPUTA ? v : 0n;
}

describe("Fuzzing do invariante S1 (modelo de referência × contrato)", function () {
  this.timeout(0);

  it(`${RUNS} campanhas × ${STEPS} passos, semente ${SEED}: S1, b = B(ρ) + D e δ conferem a cada passo`, async function () {
    const rnd = mulberry32(SEED);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

    const transicoes = new Map<string, number>(); // "estado-ação" aceitas
    let aceitas = 0;
    let revertidas = 0;
    let passosTotais = 0;
    let comD = 0;

    for (let run = 0; run < RUNS; run++) {
      const ctx = await loadFixture(deployMellowProtocolFixture);
      const { mellow, token, contratante, prestador, arbitragem, outro, valorServico: v } = ctx;
      const addr = await mellow.getAddress();
      const signer = { c: contratante, p: prestador, a: arbitragem, x: outro } as const;
      const quem = (s: any): Ator =>
        s.address === contratante.address ? "c" : s.address === prestador.address ? "p" : s.address === arbitragem.address ? "a" : "x";

      const contas = [contratante.address, prestador.address, arbitragem.address, outro.address, addr];
      const saldoTotal = async () => {
        let t = 0n;
        for (const c of contas) t += await token.balanceOf(c);
        return t;
      };
      const total0 = await saldoTotal();
      const arb0 = await token.balanceOf(arbitragem.address);
      const outro0 = await token.balanceOf(outro.address);

      // Estado do modelo de referência.
      let s = S.CRIADO as S;
      let B = 0n; // B(ρ) = Σ (e_in − e_out)
      let D = 0n; // transferências diretas
      let tauEnt = 0n;
      const tauAceite = BigInt(ctx.tauAceite);
      const tauFinanc = BigInt(ctx.tauFinanc);
      const tauExec = BigInt(ctx.tauExec);
      const dInsp = BigInt(ctx.deltaTInsp);

      for (let k = 0; k < STEPS; k++) {
        // ---- avanço do relógio: escolhe o timestamp exato do próximo bloco
        const agora = BigInt(await time.latest());
        const prazos = [tauAceite, tauFinanc, tauExec];
        if (s === S.ENTREGUE) prazos.push(tauEnt + dInsp);
        const r = rnd();
        let alvo: bigint;
        if (r < 0.7) {
          alvo = agora + 1n + BigInt(Math.floor(rnd() * 3600)); // até 1 h
        } else if (r < 0.9) {
          // prazo da guarda do estado corrente (70%) ou um prazo qualquer
          const atual: Record<number, bigint | undefined> = {
            [S.CRIADO]: tauAceite,
            [S.ACEITO]: tauFinanc,
            [S.FINANCIADO]: tauExec,
            [S.EM_EXECUCAO]: tauExec,
            [S.ENTREGUE]: tauEnt + dInsp,
          };
          const p = atual[s] !== undefined && rnd() < 0.7 ? atual[s]! : pick(prazos);
          alvo = p + BigInt(pick([-1, 0, 1])); // vizinhança de um prazo
        } else {
          alvo = agora + 1n + BigInt(Math.floor(rnd() * 8 * 24 * 3600)); // até 8 dias
        }
        if (alvo <= agora) alvo = agora + 1n;
        await time.setNextBlockTimestamp(alvo);
        const t = alvo;

        // ---- sorteio da ação e do ator
        // Metade dos passos é guiada: escolhe um evento habilitado em s com o
        // ator autorizado, para que as campanhas alcancem os estados profundos;
        // a outra metade é uniforme sobre ações e atores (inclui não autorizados).
        const habilitados: Record<number, [Acao, Ator][]> = {
          [S.CRIADO]: [["s1", "p"], ["s7", "x"]],
          [S.ACEITO]: [["s2", "c"], ["s7", "p"]],
          [S.FINANCIADO]: [["s3", "p"], ["s7", "c"]],
          [S.EM_EXECUCAO]: [["s4", "p"], ["s7", "a"]],
          [S.ENTREGUE]: [["s5", "c"], ["s6", "c"], ["s6", "p"], ["s7", "x"]],
          [S.EM_DISPUTA]: [["s8", "a"]],
          [S.CONCLUIDO]: [],
          [S.CANCELADO]: [],
        };
        let acao: Acao;
        let ator: Ator;
        if (rnd() < 0.5 && habilitados[s].length > 0) {
          [acao, ator] = pick(habilitados[s]);
        } else {
          acao = pick(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s7", "s8", "D"] as const);
          ator = acao === "D" ? "x" : pick(["c", "p", "a", "x", "c", "p"] as const);
        }
        const valorS8 = pick([0n, 1n, v / 2n, v - 1n, v, v + 1n, BigInt(Math.floor(rnd() * Number(v)))]);

        // ---- previsão do modelo: aceita? próximo estado? efeitos?
        let ok = false;
        let prox: S = s;
        let eIn = 0n;
        let eOut = 0n;
        switch (acao) {
          case "s1": ok = ator === "p" && s === S.CRIADO; prox = S.ACEITO; break;
          case "s2": ok = ator === "c" && s === S.ACEITO; prox = S.FINANCIADO; eIn = v; break;
          case "s3": ok = ator === "p" && s === S.FINANCIADO; prox = S.EM_EXECUCAO; break;
          case "s4": ok = ator === "p" && s === S.EM_EXECUCAO; prox = S.ENTREGUE; break;
          case "s5": ok = ator === "c" && s === S.ENTREGUE; prox = S.CONCLUIDO; eOut = v; break;
          case "s6": ok = (ator === "c" || ator === "p") && s === S.ENTREGUE; prox = S.EM_DISPUTA; break;
          case "s7":
            if (s === S.CRIADO) { ok = t > tauAceite; prox = S.CANCELADO; }
            else if (s === S.ACEITO) { ok = t > tauFinanc; prox = S.CANCELADO; }
            else if (s === S.FINANCIADO || s === S.EM_EXECUCAO) { ok = t > tauExec; prox = S.EM_DISPUTA; }
            else if (s === S.ENTREGUE) { ok = t > tauEnt + dInsp; prox = S.CONCLUIDO; eOut = v; }
            else ok = false;
            break;
          case "s8": ok = ator === "a" && s === S.EM_DISPUTA && valorS8 <= v; prox = S.CONCLUIDO; eOut = v; break;
          case "D": ok = true; break;
        }

        // ---- execução no contrato
        const antesP = await token.balanceOf(prestador.address);
        const antesC = await token.balanceOf(contratante.address);
        let sucesso = true;
        try {
          const m = mellow.connect(signer[ator]);
          let tx;
          switch (acao) {
            case "s1": tx = await m.aceitar(); break;
            case "s2": tx = await m.financiar(); break;
            case "s3": tx = await m.iniciarExecucao(); break;
            case "s4": tx = await m.confirmarEntrega([`bafy_fuzz_${run}_${k}`]); break;
            case "s5": tx = await m.aprovarPagamento(); break;
            case "s6": tx = await m.abrirDisputa([`bafy_disp_${run}_${k}`]); break;
            case "s7": tx = await m.acionarWatchdog(); break;
            case "s8": tx = await m.executarDecisao(valorS8); break;
            case "D": {
              const q = BigInt(1 + Math.floor(rnd() * 1000));
              tx = await token.connect(outro).transfer(addr, q);
              D += q;
              comD++;
              break;
            }
          }
          await tx!.wait();
        } catch {
          sucesso = false;
          // a transação revertida não minera bloco: consome o timestamp agendado
          await ethers.provider.send("evm_mine", []);
        }
        passosTotais++;

        const rotulo = `run ${run} passo ${k} (${acao} por ${ator}, estado ${S[s]}, t=${t})`;
        // (i) aceitação prevista = observada
        expect(sucesso, `δ divergente em ${rotulo}`).to.equal(ok);

        if (ok && acao !== "D") {
          aceitas++;
          const chave = `${S[s]}-${acao}`;
          transicoes.set(chave, (transicoes.get(chave) ?? 0) + 1);
          if (acao === "s4") tauEnt = t;
          // efeitos financeiros: e_out vai ao destinatário correto
          if (acao === "s5" || (acao === "s7" && s === S.ENTREGUE)) {
            expect((await token.balanceOf(prestador.address)) - antesP).to.equal(v);
          }
          if (acao === "s8") {
            expect((await token.balanceOf(prestador.address)) - antesP).to.equal(valorS8);
            expect((await token.balanceOf(contratante.address)) - antesC).to.equal(v - valorS8);
          }
          B += eIn - eOut;
          s = prox;
        } else if (!ok) {
          revertidas++;
        }

        // (ii) estado
        expect(Number(await mellow.estado()), `estado em ${rotulo}`).to.equal(s);
        // (iii) S1: B(ρ) = 𝓕(s)
        expect(B, `S1 em ${rotulo}`).to.equal(F(s, v));
        // (iv) saldo real = B(ρ) + D
        expect(await token.balanceOf(addr), `saldo real em ${rotulo}`).to.equal(B + D);
        // (v) nenhum valor ao árbitro ou ao terceiro; conservação
        expect(await token.balanceOf(arbitragem.address)).to.equal(arb0);
        expect(await token.balanceOf(outro.address)).to.equal(outro0 - D);
        expect(await saldoTotal()).to.equal(total0);
      }
    }

    // Resumo da campanha (registrado no relatório de experimentos).
    const linhas = [...transicoes.entries()].sort().map(([k, n]) => `    ${k}: ${n}`);
    console.log(
      `\n    Fuzzing S1: semente ${SEED}, ${RUNS} campanhas, ${passosTotais} passos, ` +
        `${aceitas} transições aceitas, ${revertidas} chamadas revertidas, ${comD} transferências diretas\n` +
        `    Pares (estado, evento) aceitos distintos: ${transicoes.size}\n` +
        linhas.join("\n")
    );

    // As 12 transições definidas de δ devem ter sido exercitadas.
    // (σ7 em CRIADO, ACEITO, FINANCIADO, EM_EXECUCAO, ENTREGUE conta como 5 pares,
    // e σ1..σ6, σ8 como 7 pares; total 12.)
    expect(transicoes.size).to.equal(12);
  });
});

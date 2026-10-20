"""Exploração exaustiva em tempo discreto (passo 1/2) do modelo mellow_uppaal.xml.

Não substitui o UPPAAL: verifica as mesmas consultas sobre a digitalização do
autômato com passo de meia unidade, suficiente para guardas estritas (x > c) e
invariantes não estritos (x <= c) com constantes inteiras. Serve para conferir
que o modelo foi escrito como pretendido antes de executá-lo no verificador.
Uso: python3 modelo/explorar_discreto.py [delta_tmax]
     delta_tmax (opcional, inteiro) soma-se a T_max; com -1, o script deve
     acusar violações de horizonte, o que confirma que o horizonte é justo.
A exploração usa uma reimplementação em Python do autômato do arquivo XML,
e não o próprio XML.
"""
import sys
from fractions import Fraction as Q

TA, TF, TE, DI, TDISP, EPS, V = 3, 6, 20, 5, 7, 1, 10
TMAX = TE + DI + TDISP + 2 * EPS + (int(sys.argv[1]) if len(sys.argv) > 1 else 0)
H = Q(1, 2)
ABS = {"CONCLUIDO", "CANCELADO"}
ATIVOS = {"FINANCIADO", "EM_EXECUCAO", "ENTREGUE", "EM_DISPUTA"}

def inv(s, x0, xent, xd):
    return {"CRIADO": x0 <= TA + EPS, "ACEITO": x0 <= TF + EPS, "FINANCIADO": x0 <= TE + EPS,
            "EM_EXECUCAO": x0 <= TE + EPS, "ENTREGUE": xent <= DI + EPS,
            "EM_DISPUTA": xd <= TDISP}.get(s, True)

def acoes(st):
    s, x0, xent, xd, B, pP, pC, liq = st
    r = []
    if s == "CRIADO":
        r.append(("ACEITO", x0, xent, xd, B, pP, pC, liq))
        if x0 > TA: r.append(("CANCELADO", x0, xent, xd, B, pP, pC, liq))
    elif s == "ACEITO":
        r.append(("FINANCIADO", x0, xent, xd, B + V, pP, pC, liq))
        if x0 > TF: r.append(("CANCELADO", x0, xent, xd, B, pP, pC, liq))
    elif s == "FINANCIADO":
        r.append(("EM_EXECUCAO", x0, xent, xd, B, pP, pC, liq))
        if x0 > TE: r.append(("EM_DISPUTA", x0, xent, 0, B, pP, pC, liq))
    elif s == "EM_EXECUCAO":
        r.append(("ENTREGUE", x0, 0, xd, B, pP, pC, liq))
        if x0 > TE: r.append(("EM_DISPUTA", x0, xent, 0, B, pP, pC, liq))
    elif s == "ENTREGUE":
        r.append(("CONCLUIDO", x0, xent, xd, B - V, pP + V, pC, liq + 1))
        r.append(("EM_DISPUTA", x0, xent, 0, B, pP, pC, liq))
        if xent > DI: r.append(("CONCLUIDO", x0, xent, xd, B - V, pP + V, pC, liq + 1))
    elif s == "EM_DISPUTA":
        for val in range(V + 1):
            r.append(("CONCLUIDO", x0, xent, xd, B - V, pP + val, pC + V - val, liq + 1))
    return r

ini = ("CRIADO", Q(0), Q(0), Q(0), 0, 0, 0, 0)
vistos, pilha = {ini}, [ini]
viol = {"S1": 0, "S2": 0, "cancel": 0, "horizonte": 0, "bloqueio": 0}
pior_disputa_em_tmax = False
while pilha:
    st = pilha.pop()
    s, x0, xent, xd, B, pP, pC, liq = st
    F = V if s in ATIVOS else 0
    viol["S1"] += B != F
    viol["S2"] += not (liq <= 1 and pP + pC == V * liq)
    viol["cancel"] += s == "CANCELADO" and (pP or pC)
    viol["horizonte"] += s not in ABS and x0 > TMAX
    pior_disputa_em_tmax |= s == "EM_DISPUTA" and x0 == TMAX
    succ = acoes(st)
    if s in ABS:
        continue  # absorvente: só o tempo passa; nada mais a verificar
    atraso = (s, x0 + H, xent + H, xd + H, B, pP, pC, liq)
    if inv(*atraso[:4]):
        succ.append(atraso)
    if not succ:
        viol["bloqueio"] += 1
    for n in succ:
        if inv(*n[:4]) and n not in vistos:
            vistos.add(n); pilha.append(n)

print(f"estados explorados: {len(vistos)}; T_max = {TMAX}")
print("violações:", viol)
print("EM_DISPUTA alcançável com x0 = T_max:", pior_disputa_em_tmax)
# L1 (A<>): sem violação de horizonte e sem bloqueio fora dos absorventes, toda
# execução de tempo divergente deixa os estados transientes até T_max.

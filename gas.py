"""Mediana de 30 dias do preço do gás na Polygon PoS (P_gas) e conversão para BRL.

Fonte de P_gas: API de histórico da Owlracle (endpoint v4/poly/history,
timeframe de 1 dia, 30 candles), mediana dos preços de fechamento diários.

A chave da API é lida da variável de ambiente OWLRACLE_API_KEY e nunca deve
ser gravada no repositório:

    export OWLRACLE_API_KEY=...   # ou defina no arquivo .env (ignorado pelo git)
    python gas.py

Os valores de gás abaixo são os medidos por recibo em scripts/medirGasReal.ts.

Reprodutibilidade: a API devolve os 30 dias anteriores à data da execução.
A mediana usada na dissertação (374,86 Gwei) corresponde à execução de
23/08/2026; uma execução posterior cobre outra janela e produz outro valor.
Guarde a resposta bruta da API junto aos dados do experimento.

Observado em 10/10/2026: o endpoint devolve no máximo os 30 candles mais
recentes (os parâmetros candles > 30 e `to` são ignorados) e não inclui o
campo tokenPrice. P_POL deve vir de outra fonte com histórico diário e ser
informado pela variável de ambiente P_POL. A consulta de 10/10/2026 está em
scripts/out/owlracle_2026-10-10.json (mediana de 328,79 Gwei).
"""

import os
import statistics
import sys

import requests

API_KEY = os.environ.get("OWLRACLE_API_KEY")
if not API_KEY:
    sys.exit("Defina a variável de ambiente OWLRACLE_API_KEY antes de executar.")

# --- 1) Histórico de 30 dias ---
url = "https://api.owlracle.info/v4/poly/history"
params = {"apikey": API_KEY, "timeframe": "1d", "candles": 30}
resp = requests.get(url, params=params, timeout=30)
resp.raise_for_status()
candles = resp.json()["candles"]
print(f"Candles recebidos: {len(candles)}\n")

# --- 2) Fechamentos diários do preço do gás (Gwei) e, quando presente, do token ---
fechamentos_gwei = [c["gasPrice"]["close"] for c in candles]
fechamentos_token = [c["tokenPrice"]["close"] for c in candles if isinstance(c.get("tokenPrice"), dict)]

print("Fechamentos diários, do mais recente ao mais antigo:")
for c in candles:
    linha = f"  {c['timestamp'][:10]}  gas close={c['gasPrice']['close']:.2f} Gwei"
    if isinstance(c.get("tokenPrice"), dict):
        linha += f"  POL close=US$ {c['tokenPrice']['close']:.4f}"
    print(linha)

mediana_gwei = statistics.median(fechamentos_gwei)
print(f"\n=== P_gas sobre {len(fechamentos_gwei)} dias ===")
print(f"Mediana : {mediana_gwei:.2f} Gwei")
print(f"Média   : {statistics.mean(fechamentos_gwei):.2f} Gwei")
print(f"Mínimo  : {min(fechamentos_gwei):.2f} Gwei")
print(f"Máximo  : {max(fechamentos_gwei):.2f} Gwei")
if fechamentos_token:
    print(f"POL no fechamento mais recente: US$ {fechamentos_token[0]:.4f} (mesma fonte, Owlracle)")

# --- 3) Conversão para BRL ---
# P_POL: a Owlracle não devolve o preço do token (verificado em 10/10/2026); informar P_POL
#        por variável de ambiente, a partir de fonte com histórico diário.
# P_USD_BRL: PTAX de venda do Banco Central do último dia útil anterior à coleta
#            (a coleta de 23/08/2026 caiu em um domingo, sem PTAX nesse dia).
P_POL = fechamentos_token[0] if fechamentos_token else float(os.environ.get("P_POL", "0.1091"))  # CoinMarketCap, fechamento diário (UTC) de 23/08/2026: 0,10914304
P_USD_BRL = float(os.environ.get("P_USD_BRL", "5.1625"))  # PTAX venda 21/08/2026 (BCB)

GAS = {
    # Valores medidos por recibo em scripts/medirGasReal.ts (revisão com
    # financiar protegido por nonReentrant; ver RELATORIO_EXPERIMENTOS.md).
    "Ciclo nominal (sigma1->sigma5)": 289_887,
    "Ciclo via watchdog Delta t4": 293_417,
    "Ciclo com disputa, decisão parcial": 391_050,
    "Ciclo nominal, evidência CIDv1": 335_189,
    "Ciclo com disputa, evidências CIDv1": 481_728,
    "Implantação + approve + ciclo nominal, CIDv1": 1_606_196 + 45_945 + 335_189,
    "Implantação + approve + ciclo com disputa, CIDv1": 1_606_196 + 45_945 + 481_728,
}
TETO = 200 * 0.015


def custo_brl(gas_units: int, p_gas_gwei: float) -> float:
    return gas_units * p_gas_gwei * 1e-9 * P_POL * P_USD_BRL


print(f"\n=== Conversão para BRL (P_gas={mediana_gwei:.2f} Gwei, P_POL=US$ {P_POL}, P_USD/BRL=R$ {P_USD_BRL}) ===")
for nome, g in GAS.items():
    c = custo_brl(g, mediana_gwei)
    print(f"{nome:<48} {g:>10,} gás  R$ {c:.4f}  ({100 * c / TETO:.2f}% do teto de R$ {TETO:.2f})")

# Modelo temporizado para o UPPAAL

- `mellow_uppaal.xml`: autômato temporizado M_τ do Capítulo 3, com as consultas de S1, S2 e L1 embutidas (seção `<queries>`). As premissas H1 (o árbitro decide em até `TDISP`) e H2 (σ7 é incluído em até `EPS` após o vencimento) entram como invariantes de localização. O tempo está em escala abstrata, com constantes pequenas que preservam a ordem dos prazos de P.
- `explorar_discreto.py`: exploração exaustiva do mesmo modelo em tempo discreto, com passo de 1/2. Confere as consultas sem o UPPAAL.

## Como executar no UPPAAL

Em uma máquina com UPPAAL 4.1 ou 5.x:

```
verifyta modelo/mellow_uppaal.xml
```

**Resultado (UPPAAL 5.0.0, 10/10/2026): as 10 consultas são satisfeitas**, com 18 estados simbólicos e menos de 0,1 s. Com `TMAX` reduzido em uma unidade, só a consulta de L1 com horizonte falha. Saída completa em [`verifyta_saida.txt`](verifyta_saida.txt).

## Resultado da exploração discreta

`python3 modelo/explorar_discreto.py`:
- 102 199 estados explorados.
- Nenhuma violação de S1, S2, do horizonte T_max = 34 ou de ausência de bloqueio.
- EM_DISPUTA é alcançável com x0 = T_max, o que mostra que o horizonte é justo.

Teste de sensibilidade: `python3 modelo/explorar_discreto.py -1`, que reduz T_max em uma unidade, acusa 4 violações de horizonte.

O script reimplementa em Python o autômato descrito no XML. Ele confere essa reimplementação, e não o arquivo XML em si.

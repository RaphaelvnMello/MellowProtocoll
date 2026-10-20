// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArbitration} from "./interfaces/IArbitration.sol";

/// @title MellowProtocol
/// @notice Implementação de referência da MEFD (Máquina de Estados Finita
///         Determinística) formalizada nos Capítulos 2 e 3 da dissertação.
///         Segue a regra de identidade nominal entre a MEFD e o código
///         (Capítulo 3, Seção 3.3): estados, eventos e transições recebem os
///         mesmos nomes usados na especificação formal, sem nomenclatura de
///         código independente.
///
/// Rastreabilidade:
///   S (Seção 2 do roteiro) → enum EstadoContrato, rótulos e ordem idênticos.
///   Σ (Seção 3)            → as 8 funções external abaixo, mesma assinatura.
///   δ (Seção 4)            → um modifier `emEstado` por função + atribuição
///                             de estado ao final; pares ausentes na matriz
///                             não recebem modifier habilitado (revert
///                             implícito, sem cláusula `else revert`).
///   C (Seção 5)            → acionarWatchdog() despacha os 4 relógios.
///
/// Mapeamento ASCII do vetor de parâmetros P = ⟨αc, αp, v, τ_aceite,
/// τ_financ, τ_exec, Δt_insp, CID_spec⟩ (Solidity não aceita identificadores
/// gregos): αc→contratante, αp→prestador, v→v, τ_x→tauX, Δt_insp→deltaTInsp,
/// CID_spec→cidSpec. `token` e `arbitragem` são parâmetros adicionais de
/// implementação, não literais em P (ver Seção 1 do roteiro).
contract MellowProtocol is ReentrancyGuard, IArbitration {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Conjunto de estados S (Seção 2)
    // ---------------------------------------------------------------------
    enum EstadoContrato {
        CRIADO,
        ACEITO,
        FINANCIADO,
        EM_EXECUCAO,
        ENTREGUE,
        EM_DISPUTA,
        CONCLUIDO,
        CANCELADO
    }

    // ---------------------------------------------------------------------
    // Vetor de parâmetros imutáveis P (Seção 1)
    // ---------------------------------------------------------------------
    address public immutable contratante; // αc
    address public immutable prestador; // αp
    uint256 public immutable v; // valor do serviço, em unidades mínimas do token
    uint256 public immutable tauAceite; // τ_aceite
    uint256 public immutable tauFinanc; // τ_financ
    uint256 public immutable tauExec; // τ_exec
    uint256 public immutable deltaTInsp; // Δt_insp (intervalo relativo)

    /// @notice CID_spec. `string` é tipo dinâmico e não é elegível à palavra-
    ///         chave `immutable` em Solidity 0.8.20; sem função de escrita
    ///         após o construtor, permanece imutável em espírito.
    string public cidSpec;

    /// @notice Parâmetro adicional de implementação (Seção 1): endereço do
    ///         token ERC-20 estável usado para custódia. Não é literal do
    ///         vetor P, mas tecnicamente necessário — documentado como
    ///         extensão de design no capítulo de experimentos.
    IERC20 public immutable token;

    /// @notice Parâmetro adicional de implementação: endereço autorizado do
    ///         módulo/agente de arbitragem (ator de σ8), tratado como
    ///         caixa-preta — ver contracts/interfaces/IArbitration.sol.
    address public immutable arbitragem;

    // ---------------------------------------------------------------------
    // Estado dinâmico (fora do vetor P)
    // ---------------------------------------------------------------------
    EstadoContrato public estado;

    /// @notice τ_ent — timestamp da transição EM_EXECUCAO → ENTREGUE, gravado
    ///         dinamicamente em block.timestamp (Seção 5), ao contrário de
    ///         τ_aceite/τ_financ/τ_exec, que são fixados no deploy.
    uint256 public tauEnt;

    string[] private _cidsEntrega;
    string[] private _cidsDisputa;

    // ---------------------------------------------------------------------
    // Eventos
    // ---------------------------------------------------------------------
    event ContratoAceito(address indexed prestador);
    event ContratoFinanciado(address indexed contratante, uint256 valor);
    event ExecucaoIniciada(address indexed prestador);
    event EntregaConfirmada(address indexed prestador, uint256 tauEnt, string[] cids);
    event PagamentoAprovado(address indexed contratante, address indexed prestador, uint256 valor);
    event DisputaAberta(address indexed autor, string[] cids);
    event WatchdogAcionado(EstadoContrato de, EstadoContrato para);
    event ContratoCancelado();

    /// @notice Evento obrigatório (Seção 7 do roteiro), emitido em executarDecisao.
    ///         `indexed` nos dois endereços melhora a filtragem de logs sem
    ///         alterar a assinatura (nomes, ordem e tipos dos parâmetros
    ///         permanecem exatamente os do texto literal da Seção 7).
    event DisputaResolvida(address indexed contratante, address indexed prestador, uint256 valorLiberado);

    // ---------------------------------------------------------------------
    // Custom errors (Seção 7 — reduzem calldata de reverts frente a strings)
    // ---------------------------------------------------------------------
    error EstadoInvalido();
    error NaoAutorizado();
    error DepositoInvalido();
    error PrazoNaoExpirado();
    error ValorInvalido();
    error EnderecoInvalido();
    error PrazosInvalidos();

    // ---------------------------------------------------------------------
    // Modifiers — implementam δ(s, σ): guarda de estado + guarda de ator.
    // ---------------------------------------------------------------------
    modifier emEstado(EstadoContrato esperado) {
        if (estado != esperado) revert EstadoInvalido();
        _;
    }

    modifier apenasContratante() {
        if (msg.sender != contratante) revert NaoAutorizado();
        _;
    }

    modifier apenasPrestador() {
        if (msg.sender != prestador) revert NaoAutorizado();
        _;
    }

    modifier apenasContratanteOuPrestador() {
        if (msg.sender != contratante && msg.sender != prestador) revert NaoAutorizado();
        _;
    }

    modifier apenasArbitragem() {
        if (msg.sender != arbitragem) revert NaoAutorizado();
        _;
    }

    constructor(
        address _contratante,
        address _prestador,
        uint256 _v,
        uint256 _tauAceite,
        uint256 _tauFinanc,
        uint256 _tauExec,
        uint256 _deltaTInsp,
        string memory _cidSpec,
        IERC20 _token,
        address _arbitragem
    ) {
        if (_contratante == address(0) || _prestador == address(0) || _arbitragem == address(0)) {
            revert EnderecoInvalido();
        }
        if (address(_token) == address(0)) revert EnderecoInvalido();
        if (_v == 0) revert ValorInvalido();
        // Os três prazos absolutos devem ser estritamente crescentes:
        // τ_aceite < τ_financ < τ_exec (premissa de instanciação do vetor P,
        // Seção 1). Δt_insp é relativo a τ_ent (dinâmico) e não entra nesta
        // ordenação.
        if (_tauAceite >= _tauFinanc || _tauFinanc >= _tauExec) revert PrazosInvalidos();

        contratante = _contratante;
        prestador = _prestador;
        v = _v;
        tauAceite = _tauAceite;
        tauFinanc = _tauFinanc;
        tauExec = _tauExec;
        deltaTInsp = _deltaTInsp;
        cidSpec = _cidSpec;
        token = _token;
        arbitragem = _arbitragem;

        estado = EstadoContrato.CRIADO;
    }

    // ---------------------------------------------------------------------
    // σ1 — aceitar() : CRIADO → ACEITO, ator = αp
    // ---------------------------------------------------------------------
    function aceitar() external apenasPrestador emEstado(EstadoContrato.CRIADO) {
        estado = EstadoContrato.ACEITO;
        emit ContratoAceito(msg.sender);
    }

    // ---------------------------------------------------------------------
    // σ2 — financiar() : ACEITO → FINANCIADO, ator = αc
    // Custódia via ERC-20: safeTransferFrom + verificação de diferencial de
    // saldo pós-execução (balance delta check), exigindo `approve` prévio.
    // checks-effects-interactions: o estado é gravado antes da chamada ao
    // token, e nonReentrant impede que um gancho do token reentre no
    // contrato (por exemplo, em σ7) durante a transferência. Se o depósito
    // for incompleto, a reversão desfaz também a gravação do estado.
    // ---------------------------------------------------------------------
    function financiar() external nonReentrant apenasContratante emEstado(EstadoContrato.ACEITO) {
        estado = EstadoContrato.FINANCIADO;
        emit ContratoFinanciado(msg.sender, v);

        uint256 saldoAntes = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), v);
        uint256 saldoDepois = token.balanceOf(address(this));
        if (saldoDepois - saldoAntes != v) revert DepositoInvalido();
    }

    // ---------------------------------------------------------------------
    // σ3 — iniciarExecucao() : FINANCIADO → EM_EXECUCAO, ator = αp
    // ---------------------------------------------------------------------
    function iniciarExecucao() external apenasPrestador emEstado(EstadoContrato.FINANCIADO) {
        estado = EstadoContrato.EM_EXECUCAO;
        emit ExecucaoIniciada(msg.sender);
    }

    // ---------------------------------------------------------------------
    // σ4 — confirmarEntrega(cids) : EM_EXECUCAO → ENTREGUE, ator = αp
    // τ_ent é gravado dinamicamente aqui (block.timestamp) — ver Seção 5.
    // ---------------------------------------------------------------------
    function confirmarEntrega(string[] calldata cids) external apenasPrestador emEstado(EstadoContrato.EM_EXECUCAO) {
        tauEnt = block.timestamp;
        delete _cidsEntrega;
        for (uint256 i = 0; i < cids.length; i++) {
            _cidsEntrega.push(cids[i]);
        }

        estado = EstadoContrato.ENTREGUE;
        emit EntregaConfirmada(msg.sender, tauEnt, cids);
    }

    // ---------------------------------------------------------------------
    // σ5 — aprovarPagamento() : ENTREGUE → CONCLUIDO, ator = αc
    // Saída de fundos: ordem checks-effects-interactions + nonReentrant.
    // ---------------------------------------------------------------------
    function aprovarPagamento() external nonReentrant apenasContratante emEstado(EstadoContrato.ENTREGUE) {
        estado = EstadoContrato.CONCLUIDO;
        emit PagamentoAprovado(msg.sender, prestador, v);
        token.safeTransfer(prestador, v);
    }

    // ---------------------------------------------------------------------
    // σ6 — abrirDisputa(cids) : ENTREGUE → EM_DISPUTA, ator = αc ou αp
    // Única célula não-∅ da coluna σ6 na matriz da Seção 4: disputas de
    // escopo/qualidade só se abrem após entrega confirmada. Atraso na
    // execução (FINANCIADO/EM_EXECUCAO além de τ_exec) já é tratado por Δt3
    // via acionarWatchdog(), não por abrirDisputa().
    // ---------------------------------------------------------------------
    function abrirDisputa(string[] calldata cids)
        external
        apenasContratanteOuPrestador
        emEstado(EstadoContrato.ENTREGUE)
    {
        delete _cidsDisputa;
        for (uint256 i = 0; i < cids.length; i++) {
            _cidsDisputa.push(cids[i]);
        }

        estado = EstadoContrato.EM_DISPUTA;
        emit DisputaAberta(msg.sender, cids);
    }

    // ---------------------------------------------------------------------
    // σ7 — acionarWatchdog() : despacho pelos 4 relógios (Seção 5)
    // Função pública única, sem ator restrito, decidindo pela guarda
    // temporal do estado corrente via block.timestamp. Δt4 movimenta
    // fundos → nonReentrant cobre a função inteira.
    // ---------------------------------------------------------------------
    function acionarWatchdog() external nonReentrant {
        EstadoContrato estadoAtual = estado;

        if (estadoAtual == EstadoContrato.CRIADO) {
            // Δt1: t > τ_aceite → CANCELADO (sem saldo, retorno nulo)
            if (block.timestamp <= tauAceite) revert PrazoNaoExpirado();
            estado = EstadoContrato.CANCELADO;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.CANCELADO);
            emit ContratoCancelado();
            return;
        }

        if (estadoAtual == EstadoContrato.ACEITO) {
            // Δt2: t > τ_financ → CANCELADO (sem saldo, retorno nulo)
            if (block.timestamp <= tauFinanc) revert PrazoNaoExpirado();
            estado = EstadoContrato.CANCELADO;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.CANCELADO);
            emit ContratoCancelado();
            return;
        }

        if (estadoAtual == EstadoContrato.FINANCIADO || estadoAtual == EstadoContrato.EM_EXECUCAO) {
            // Δt3: t > τ_exec → EM_DISPUTA (ativos congelados p/ arbitragem)
            if (block.timestamp <= tauExec) revert PrazoNaoExpirado();
            estado = EstadoContrato.EM_DISPUTA;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.EM_DISPUTA);
            return;
        }

        if (estadoAtual == EstadoContrato.ENTREGUE) {
            // Δt4: t > τ_ent + Δt_insp → CONCLUIDO (liberação automática a αp)
            if (block.timestamp <= tauEnt + deltaTInsp) revert PrazoNaoExpirado();
            estado = EstadoContrato.CONCLUIDO;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.CONCLUIDO);
            emit PagamentoAprovado(contratante, prestador, v);
            token.safeTransfer(prestador, v);
            return;
        }

        // EM_DISPUTA, CONCLUIDO, CANCELADO: nenhum relógio ativo (Seção 5)
        revert EstadoInvalido();
    }

    // ---------------------------------------------------------------------
    // σ8 — executarDecisao(valor) : EM_DISPUTA → CONCLUIDO, ator = arbitragem
    // Libera `valor` a αp e o restante do saldo custodiado (v - valor) a αc.
    // ---------------------------------------------------------------------
    function executarDecisao(uint256 valor)
        external
        override
        nonReentrant
        apenasArbitragem
        emEstado(EstadoContrato.EM_DISPUTA)
    {
        if (valor > v) revert ValorInvalido();

        estado = EstadoContrato.CONCLUIDO;
        emit DisputaResolvida(contratante, prestador, valor);

        if (valor > 0) {
            token.safeTransfer(prestador, valor);
        }
        uint256 restante = v - valor;
        if (restante > 0) {
            token.safeTransfer(contratante, restante);
        }
    }

    // ---------------------------------------------------------------------
    // Views auxiliares (fora de Σ; apenas leitura de estado)
    // ---------------------------------------------------------------------
    function cidsEntrega() external view returns (string[] memory) {
        return _cidsEntrega;
    }

    function cidsDisputa() external view returns (string[] memory) {
        return _cidsDisputa;
    }
}

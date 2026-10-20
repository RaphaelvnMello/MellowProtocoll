// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IArbitration} from "../interfaces/IArbitration.sol";

/// @title MellowProtocolClonable
/// @notice Variante experimental de MellowProtocol.sol compatível com o
///         padrão EIP-1167 de proxy mínimo via `Clones.cloneWithImmutableArgs`
///         (OpenZeppelin Contracts 5.6.1).
///
/// Resolve a tensão de design documentada em RELATORIO_EXPERIMENTOS.md
/// (Seção 3, "Economia do Minimal Proxy"): o `MellowProtocol.sol` principal
/// usa variáveis Solidity `immutable`, cujo valor é embutido no bytecode da
/// própria implementação no momento de SUA criação — um clone EIP-1167
/// clássico (`Clones.clone`) delegatecalla para essa implementação e, como
/// não re-executa o construtor, todos os clones leriam o MESMO valor
/// embutido, quebrando o requisito de cada instância representar um acordo
/// distinto.
///
/// Esta variante não usa `immutable` para o vetor P: em vez disso, P é
/// codificado como os "argumentos imutáveis" anexados ao bytecode de CADA
/// clone (`Clones.cloneWithImmutableArgs`) e lido em tempo de execução via
/// `Clones.fetchCloneArgs(address(this))`. Como `address(this)` dentro de
/// uma chamada via `delegatecall` resolve para o endereço do clone (não da
/// implementação), cada clone lê seus PRÓPRIOS argumentos — resolvendo a
/// tensão sem exigir um padrão `initialize()`/`Initializable` com storage
/// comum.
///
/// Mantém nome idêntico de estados, eventos, erros e assinaturas Σ em
/// relação a MellowProtocol.sol, para que a comparação de gás seja
/// apples-to-apples. Validação do vetor P (endereços não-zero, v > 0,
/// ordenação de prazos) é responsabilidade da fábrica (MellowProtocolCloneFactory),
/// executada ANTES do clone ser criado — não há construtor aqui que a
/// imponha no momento do deploy do clone.
contract MellowProtocolClonable is ReentrancyGuard, IArbitration {
    using SafeERC20 for IERC20;

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

    struct ParametrosP {
        address contratante;
        address prestador;
        uint256 v;
        uint256 tauAceite;
        uint256 tauFinanc;
        uint256 tauExec;
        uint256 deltaTInsp;
        string cidSpec;
        address token;
        address arbitragem;
    }

    // Estado dinâmico — vive no storage do CLONE (delegatecall preserva o
    // storage do chamador), não no storage da implementação.
    EstadoContrato public estado; // defaults para CRIADO (0) em cada clone novo
    uint256 public tauEnt;
    string[] private _cidsEntrega;
    string[] private _cidsDisputa;

    event ContratoAceito(address indexed prestador);
    event ContratoFinanciado(address indexed contratante, uint256 valor);
    event ExecucaoIniciada(address indexed prestador);
    event EntregaConfirmada(address indexed prestador, uint256 tauEnt, string[] cids);
    event PagamentoAprovado(address indexed contratante, address indexed prestador, uint256 valor);
    event DisputaAberta(address indexed autor, string[] cids);
    event WatchdogAcionado(EstadoContrato de, EstadoContrato para);
    event ContratoCancelado();
    event DisputaResolvida(address indexed contratante, address indexed prestador, uint256 valorLiberado);

    error EstadoInvalido();
    error NaoAutorizado();
    error DepositoInvalido();
    error PrazoNaoExpirado();
    error ValorInvalido();

    modifier emEstado(EstadoContrato esperado) {
        if (estado != esperado) revert EstadoInvalido();
        _;
    }

    /// @notice Decodifica o vetor P a partir dos argumentos imutáveis
    ///         anexados ao bytecode deste clone. Chamado uma vez por função
    ///         (nunca em loop) para limitar o custo do decode por chamada.
    function parametros() public view returns (ParametrosP memory p) {
        bytes memory args = Clones.fetchCloneArgs(address(this));
        (
            p.contratante,
            p.prestador,
            p.v,
            p.tauAceite,
            p.tauFinanc,
            p.tauExec,
            p.deltaTInsp,
            p.cidSpec,
            p.token,
            p.arbitragem
        ) = abi.decode(args, (address, address, uint256, uint256, uint256, uint256, uint256, string, address, address));
    }

    function aceitar() external emEstado(EstadoContrato.CRIADO) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.prestador) revert NaoAutorizado();
        estado = EstadoContrato.ACEITO;
        emit ContratoAceito(msg.sender);
    }

    function financiar() external nonReentrant emEstado(EstadoContrato.ACEITO) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.contratante) revert NaoAutorizado();

        // checks-effects-interactions e nonReentrant, como no contrato principal.
        estado = EstadoContrato.FINANCIADO;
        emit ContratoFinanciado(msg.sender, p.v);

        IERC20 token = IERC20(p.token);
        uint256 saldoAntes = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), p.v);
        uint256 saldoDepois = token.balanceOf(address(this));
        if (saldoDepois - saldoAntes != p.v) revert DepositoInvalido();
    }

    function iniciarExecucao() external emEstado(EstadoContrato.FINANCIADO) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.prestador) revert NaoAutorizado();
        estado = EstadoContrato.EM_EXECUCAO;
        emit ExecucaoIniciada(msg.sender);
    }

    function confirmarEntrega(string[] calldata cids) external emEstado(EstadoContrato.EM_EXECUCAO) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.prestador) revert NaoAutorizado();

        tauEnt = block.timestamp;
        delete _cidsEntrega;
        for (uint256 i = 0; i < cids.length; i++) {
            _cidsEntrega.push(cids[i]);
        }

        estado = EstadoContrato.ENTREGUE;
        emit EntregaConfirmada(msg.sender, tauEnt, cids);
    }

    function aprovarPagamento() external nonReentrant emEstado(EstadoContrato.ENTREGUE) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.contratante) revert NaoAutorizado();

        estado = EstadoContrato.CONCLUIDO;
        emit PagamentoAprovado(msg.sender, p.prestador, p.v);
        IERC20(p.token).safeTransfer(p.prestador, p.v);
    }

    function abrirDisputa(string[] calldata cids) external emEstado(EstadoContrato.ENTREGUE) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.contratante && msg.sender != p.prestador) revert NaoAutorizado();

        delete _cidsDisputa;
        for (uint256 i = 0; i < cids.length; i++) {
            _cidsDisputa.push(cids[i]);
        }

        estado = EstadoContrato.EM_DISPUTA;
        emit DisputaAberta(msg.sender, cids);
    }

    function acionarWatchdog() external nonReentrant {
        ParametrosP memory p = parametros();
        EstadoContrato estadoAtual = estado;

        if (estadoAtual == EstadoContrato.CRIADO) {
            if (block.timestamp <= p.tauAceite) revert PrazoNaoExpirado();
            estado = EstadoContrato.CANCELADO;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.CANCELADO);
            emit ContratoCancelado();
            return;
        }

        if (estadoAtual == EstadoContrato.ACEITO) {
            if (block.timestamp <= p.tauFinanc) revert PrazoNaoExpirado();
            estado = EstadoContrato.CANCELADO;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.CANCELADO);
            emit ContratoCancelado();
            return;
        }

        if (estadoAtual == EstadoContrato.FINANCIADO || estadoAtual == EstadoContrato.EM_EXECUCAO) {
            if (block.timestamp <= p.tauExec) revert PrazoNaoExpirado();
            estado = EstadoContrato.EM_DISPUTA;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.EM_DISPUTA);
            return;
        }

        if (estadoAtual == EstadoContrato.ENTREGUE) {
            if (block.timestamp <= tauEnt + p.deltaTInsp) revert PrazoNaoExpirado();
            estado = EstadoContrato.CONCLUIDO;
            emit WatchdogAcionado(estadoAtual, EstadoContrato.CONCLUIDO);
            emit PagamentoAprovado(p.contratante, p.prestador, p.v);
            IERC20(p.token).safeTransfer(p.prestador, p.v);
            return;
        }

        revert EstadoInvalido();
    }

    function executarDecisao(uint256 valor) external override nonReentrant emEstado(EstadoContrato.EM_DISPUTA) {
        ParametrosP memory p = parametros();
        if (msg.sender != p.arbitragem) revert NaoAutorizado();
        if (valor > p.v) revert ValorInvalido();

        estado = EstadoContrato.CONCLUIDO;
        emit DisputaResolvida(p.contratante, p.prestador, valor);

        IERC20 token = IERC20(p.token);
        if (valor > 0) {
            token.safeTransfer(p.prestador, valor);
        }
        uint256 restante = p.v - valor;
        if (restante > 0) {
            token.safeTransfer(p.contratante, restante);
        }
    }

    function cidsEntrega() external view returns (string[] memory) {
        return _cidsEntrega;
    }

    function cidsDisputa() external view returns (string[] memory) {
        return _cidsDisputa;
    }
}

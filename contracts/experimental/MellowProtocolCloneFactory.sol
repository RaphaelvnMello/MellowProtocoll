// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MellowProtocolClonable} from "./MellowProtocolClonable.sol";

/// @title MellowProtocolCloneFactory
/// @notice Fábrica experimental para medir a economia de deploy do padrão
///         EIP-1167 (Minimal Proxy) sobre MellowProtocolClonable — ver
///         RELATORIO_EXPERIMENTOS.md, Seção 3 ("Economia do Minimal Proxy").
///         Expõe dois caminhos deliberadamente, para comparação de custo:
///
///         1. `criarInstanciaNaiveSemArgumentos` — clone EIP-1167 "nu"
///            (`Clones.clone`), sem argumentos imutáveis anexados. NÃO É
///            FUNCIONAL: `parametros()` do clone resultante decodificaria
///            um array vazio e reverteria em qualquer chamada de Σ. Existe
///            apenas como referência do custo de deploy do clone mínimo
///            clássico, para contraste com o caminho funcional abaixo.
///         2. `criarInstancia` — caminho correto e funcional, via
///            `Clones.cloneWithImmutableArgs`, replicando as validações do
///            construtor de MellowProtocol.sol (Seção 1 do roteiro) antes
///            de criar o clone.
contract MellowProtocolCloneFactory {
    error EnderecoInvalido();
    error ValorInvalido();
    error PrazosInvalidos();

    /// @notice Endereço da implementação compartilhada por todos os clones.
    address public immutable implementacao;

    event InstanciaCriada(address indexed instancia, bool funcional);

    constructor() {
        implementacao = address(new MellowProtocolClonable());
    }

    /// @notice Referência de custo apenas — ver aviso na documentação do
    ///         contrato. Não usar para criar acordos reais.
    function criarInstanciaNaiveSemArgumentos() external returns (address instancia) {
        instancia = Clones.clone(implementacao);
        emit InstanciaCriada(instancia, false);
    }

    /// @notice Cria uma instância funcional de MellowProtocolClonable, com
    ///         vetor P próprio codificado como argumentos imutáveis.
    function criarInstancia(
        address contratante,
        address prestador,
        uint256 v,
        uint256 tauAceite,
        uint256 tauFinanc,
        uint256 tauExec,
        uint256 deltaTInsp,
        string calldata cidSpec,
        address token,
        address arbitragem
    ) external returns (address instancia) {
        if (contratante == address(0) || prestador == address(0) || arbitragem == address(0) || token == address(0)) {
            revert EnderecoInvalido();
        }
        if (v == 0) revert ValorInvalido();
        if (tauAceite >= tauFinanc || tauFinanc >= tauExec) revert PrazosInvalidos();

        bytes memory args = abi.encode(
            contratante,
            prestador,
            v,
            tauAceite,
            tauFinanc,
            tauExec,
            deltaTInsp,
            cidSpec,
            token,
            arbitragem
        );
        instancia = Clones.cloneWithImmutableArgs(implementacao, args);
        emit InstanciaCriada(instancia, true);
    }
}

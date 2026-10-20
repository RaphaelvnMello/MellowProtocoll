// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title IArbitration
/// @notice Interface do módulo de arbitragem externo, tratado como caixa-preta
///         pelo MellowProtocol. Qualquer endereço que implemente (ou seja
///         autorizado a chamar) `executarDecisao` sobre um MellowProtocol
///         em EM_DISPUTA satisfaz este contrato de integração.
/// @dev O MellowProtocol não depende desta interface para lógica interna —
///      ela documenta a superfície esperada do módulo de arbitragem para
///      integrações externas e para os testes que simulam o módulo.
interface IArbitration {
    /// @notice Executa a decisão de arbitragem sobre um contrato em disputa,
    ///         liberando `valor` ao prestador e o restante do saldo custodiado
    ///         ao contratante.
    /// @param valor Montante do token de custódia a ser liberado ao prestador `αp`.
    function executarDecisao(uint256 valor) external;
}

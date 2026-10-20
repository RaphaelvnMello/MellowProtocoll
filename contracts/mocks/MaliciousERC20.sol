// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MaliciousERC20
/// @notice Token ERC-20 de teste que, ao creditar tokens a um endereço de
///         "gatilho" previamente configurado, aciona o fallback/receive
///         desse endereço antes de devolver o controle ao chamador — como
///         faria um destinatário malicioso tentando reentrar durante uma
///         saída de fundos (`safeTransfer`). Usado exclusivamente em
///         reentrancy.test.ts. NÃO deve ser usado em produção.
contract MaliciousERC20 is ERC20 {
    error DestinoInvalido();

    uint8 private immutable _decimals;
    address public gatilho;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Define o endereço cujo fallback é acionado sempre que ele for
    ///         destinatário ou remetente de uma transferência deste token.
    function setGatilho(address alvo) external {
        if (alvo == address(0)) revert DestinoInvalido();
        gatilho = alvo;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // O gatilho é acionado quando ele recebe tokens (gancho de recebimento)
        // ou quando ele os envia (gancho de envio, à semelhança do ERC-777).
        if (gatilho != address(0) && (to == gatilho || from == gatilho)) {
            // O objetivo é apenas acionar o callback do destinatário durante
            // a transferência, simulando um token com hook malicioso; o
            // resultado não é persistido em storage (evitaria escrita de
            // estado após chamada externa) — é apenas verificado para não
            // descartar o retorno da chamada de baixo nível.
            (bool sucesso, ) = gatilho.call("");
            if (!sucesso) {
                // Falha silenciosa é aceitável: o callback é best-effort.
            }
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Token ERC-20 mintável sem restrições, usado apenas em ambiente de
///         teste para simular o stablecoin de custódia do MellowProtocol.
///         NÃO deve ser usado em produção.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Cunha `amount` tokens para `to`. Sem controle de acesso —
    ///         válido apenas para fixtures de teste.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

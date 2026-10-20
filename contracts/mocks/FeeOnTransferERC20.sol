// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FeeOnTransferERC20
/// @notice Token ERC-20 de teste que retém uma taxa (queimada) em cada
///         transferência, creditando ao destinatário menos do que o valor
///         nominal solicitado. Usado exclusivamente para exercitar a
///         verificação de diferencial de saldo (balance delta check) de
///         financiar() — DepositoInvalido — citada na prova de S1
///         (Capítulo 3). NÃO deve ser usado em produção.
contract FeeOnTransferERC20 is ERC20 {
    uint8 private immutable _decimals;
    uint256 public immutable feeBasisPoints; // ex.: 100 = 1%

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBasisPoints_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        feeBasisPoints = feeBasisPoints_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 taxa = (value * feeBasisPoints) / 10_000;
        super._update(from, to, value - taxa);
        if (taxa > 0) {
            super._update(from, address(0), taxa); // "queima" a taxa
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// MeridianVaultRouter — recipient-pinning trade adapter for custody vaults.
//
// DRAFT · UNAUDITED · NOT DEPLOYED. Needs a Foundry test suite (incl. the v4
// encoding verified against the live UniversalRouter) and an external audit
// before it touches real funds. See CUSTODY.md.
//
// SECURITY MODEL (the whole point of this contract):
//   A vault's scoped session key is allowed to call ONLY this adapter. The
//   adapter takes trade INTENT (which tokens, how much, min out) — never a
//   recipient — and routes the swap so that ALL proceeds return to the caller
//   (the vault). Two independent guarantees, so an encoding mistake fails
//   *safe* rather than leaking funds:
//     1. the router's output recipient is set to address(this), which the
//        caller cannot influence; and
//     2. after the swap, the adapter sweeps its entire tokenOut (and any
//        residual tokenIn) back to msg.sender, the vault.
//   A compromised session key can therefore only churn a vault's assets
//   (bounded by the backend's per-trade cap + rate limit) — it can never send
//   funds to an external address.
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract MeridianVaultRouter {
    address internal constant NATIVE = address(0);
    IUniversalRouter public immutable ROUTER;
    IPermit2 public immutable PERMIT2;

    // v4 UniversalRouter command / action ids (canonical).
    bytes1 internal constant V4_SWAP = 0x10;
    bytes1 internal constant ACTION_SWAP_EXACT_IN = 0x07;
    bytes1 internal constant ACTION_SETTLE = 0x0b;
    bytes1 internal constant ACTION_TAKE = 0x0e;

    event VaultSwap(address indexed vault, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    error InsufficientOutput(uint256 got, uint256 minOut);

    constructor(address router, address permit2) {
        ROUTER = IUniversalRouter(router);
        PERMIT2 = IPermit2(permit2);
    }

    /// @notice Swap `amountIn` of `tokenIn` for `tokenOut` on a single v4 pool.
    ///         Proceeds ALWAYS return to msg.sender (the vault). There is no
    ///         recipient parameter — that is the security property.
    /// @dev Called by a vault (Safe) via its Roles module, so msg.sender is the
    ///      vault. The vault must have approved this adapter for `tokenIn`.
    function swapExactInSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        uint128 amountIn,
        uint128 minOut
    ) external returns (uint256 amountOut) {
        address vault = msg.sender;

        // 1. pull the input from the vault into this adapter
        require(IERC20(tokenIn).transferFrom(vault, address(this), amountIn), "pull failed");

        // 2. let the router pull tokenIn from this adapter (via Permit2)
        _ensureRouterApproval(tokenIn, amountIn);

        // 3. execute the swap with output recipient = address(this) — NOT caller-controlled
        uint256 beforeBal = _balanceOf(tokenOut, address(this));
        (bytes memory commands, bytes[] memory inputs) =
            _encodeSwap(tokenIn, tokenOut, fee, tickSpacing, amountIn, minOut, address(this));
        ROUTER.execute(commands, inputs, block.timestamp);
        amountOut = _balanceOf(tokenOut, address(this)) - beforeBal;

        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        // 4. sweep everything back to the vault — proceeds cannot end up anywhere else
        _sweep(tokenOut, vault);
        _sweep(tokenIn, vault); // return any unspent input too

        emit VaultSwap(vault, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ── internals ──────────────────────────────────────────────────────────

    function _balanceOf(address token, address who) internal view returns (uint256) {
        return token == NATIVE ? who.balance : IERC20(token).balanceOf(who);
    }

    function _sweep(address token, address to) internal {
        if (token == NATIVE) {
            uint256 bal = address(this).balance;
            if (bal > 0) { (bool ok, ) = to.call{value: bal}(""); require(ok, "eth sweep"); }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) require(IERC20(token).transfer(to, bal), "sweep");
        }
    }

    function _ensureRouterApproval(address token, uint256 amount) internal {
        if (token == NATIVE) return;
        // idempotent infinite ERC20->Permit2, then Permit2->router
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(ROUTER), uint160(amount), uint48(block.timestamp + 1 hours));
    }

    /// @dev Mirrors the proven off-chain encoder (agent/src/venues/stockPools.ts
    ///      buildSwapExactInCalldata). MUST be verified against the live router
    ///      with on-chain tests before use. Even if wrong, funds are safe: a bad
    ///      encoding reverts, and `recipient` here is always address(this).
    function _encodeSwap(
        address currencyIn,
        address outputCurrency,
        uint24 fee,
        int24 tickSpacing,
        uint128 amountIn,
        uint128 minOut,
        address recipient
    ) internal pure returns (bytes memory commands, bytes[] memory inputs) {
        // path: single hop (currencyIn -> outputCurrency) at (fee, tickSpacing)
        bytes memory path = abi.encode(
            _pathKey(outputCurrency, fee, tickSpacing)
        );
        bytes memory swapParams = abi.encode(currencyIn, path, bytes(""), amountIn, minOut);
        bytes memory settleParams = abi.encode(currencyIn, uint256(0), true);
        bytes memory takeParams = abi.encode(outputCurrency, recipient, uint256(0));

        bytes memory actions = abi.encodePacked(ACTION_SWAP_EXACT_IN, ACTION_SETTLE, ACTION_TAKE);
        bytes[] memory params = new bytes[](3);
        params[0] = swapParams;
        params[1] = settleParams;
        params[2] = takeParams;

        commands = abi.encodePacked(V4_SWAP);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }

    function _pathKey(address out, uint24 fee, int24 tickSpacing) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({ intermediateCurrency: out, fee: fee, tickSpacing: tickSpacing, hooks: NATIVE, hookData: bytes("") });
    }

    receive() external payable {}
}

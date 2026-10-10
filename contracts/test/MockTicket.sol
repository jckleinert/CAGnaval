// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// Minimal ERC-1155 for local checks only (not deployed anywhere real).
interface IReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external returns (bytes4);
}

contract MockTicket {
    mapping(uint256 => mapping(address => uint256)) public balanceOf_;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function balanceOf(address a, uint256 id) external view returns (uint256) { return balanceOf_[id][a]; }
    function mint(address to, uint256 id, uint256 n) external { balanceOf_[id][to] += n; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }

    function safeTransferFrom(address from, address to, uint256 id, uint256 n, bytes calldata data) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "not allowed");
        require(balanceOf_[id][from] >= n, "balance");
        balanceOf_[id][from] -= n;
        balanceOf_[id][to] += n;
        if (to.code.length > 0) {
            require(IReceiver(to).onERC1155Received(msg.sender, from, id, n, data) == 0xf23a6e61, "rejected");
        }
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata ns, bytes calldata data) external {
        require(from == msg.sender, "not allowed");
        for (uint256 i = 0; i < ids.length; i++) {
            require(balanceOf_[ids[i]][from] >= ns[i], "balance");
            balanceOf_[ids[i]][from] -= ns[i];
            balanceOf_[ids[i]][to] += ns[i];
        }
        if (to.code.length > 0) {
            require(IReceiver(to).onERC1155BatchReceived(msg.sender, from, ids, ns, data) == 0xbc197c81, "rejected");
        }
    }
}


// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// CAGnaval Ticket: the entry ticket for the CAGnaval games on Ronin.
/// Item #1 is the ticket (1 ENTRY). Only the owner creates new tickets; nobody can take or
/// destroy anyone's tickets. The address of the pictures and texts can be moved by the owner
/// (for example when the site changes domain), but the tickets themselves never change.
contract CAGnavalTicket is ERC1155Supply, Ownable {
    string public name = "CAGnaval Ticket";
    string public symbol = "CAGT";
    uint256 public constant TICKET = 1;

    /// Where the texts and pictures live, ending in "/": item n is <baseURI>n.json
    string public baseURI;

    constructor(string memory _baseURI) ERC1155("") Ownable(msg.sender) {
        baseURI = _baseURI;
    }

    /// Texts and picture of item `id`.
    function uri(uint256 id) public view override returns (string memory) {
        return string.concat(baseURI, Strings.toString(id), ".json");
    }

    /// Texts and picture of the whole collection.
    function contractURI() external view returns (string memory) {
        return string.concat(baseURI, "collection.json");
    }

    /// Owner creates `amount` new tickets of item `id` in wallet `to`.
    function mint(address to, uint256 id, uint256 amount) external onlyOwner {
        _mint(to, id, amount, "");
    }

    /// Owner moves the texts and pictures to a new address (ending in "/").
    function setBaseURI(string calldata _baseURI) external onlyOwner {
        baseURI = _baseURI;
        emit URI(uri(TICKET), TICKET);
    }
}

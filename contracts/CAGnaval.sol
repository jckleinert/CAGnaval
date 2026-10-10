// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/*
  CAGnaval — paid runs, golden onigiri bonus and weekly prize pool, on Ronin.

  How money and tickets move
  --------------------------
  - Tickets are an ERC-1155 item. To start a run the player sends 1..maxTickets
    tickets to this contract (one safeTransferFrom, no approval needed).
    The tickets stay here; the owner withdraws them and lists them again.
  - Ticket sales reach the owner's wallet on Ronin Market, minus the market
    fee. The owner sends them with deposit(): the contract works out the
    original sale (adding the fee back) and splits it by adjustable
    percentages of the full ticket price: poolBps to the weekly pool,
    bonusBps to the golden box; the rest, minus the fee the market already
    took, goes to the treasury wallet. fundBonus / fundPool load either alone.
  - Golden onigiri: when a run ends, the referee (the game server) settles it
    and the prize is written down for the player, who claims it from the game
    (claimGold), always in full. If the box cannot cover the whole amount yet,
    it shows as pending until the box is refilled. A run can only start if the box, after
    every pending prize, still holds capPerTicket RON per ticket (one 21x
    prize). Nothing is held back while runs are open, so any number of people
    can play at once.
  - Weekly pool: after the week closes (Monday 00:00 UTC) the referee posts
    what each wallet won. Claims open claimDelay later (a safety window in
    which the owner can void a wrong posting) and close at the end of the
    following week (claimWeeks). Whatever is not claimed can be moved to a
    later week with rollover.

  Limits that hold even if the referee key leaked
  -----------------------------------------------
  - A run pays at most capPerTicket x its tickets, and only once.
  - A week can only hand out what was loaded into that week's pool, and only
    after the week has ended.
  - Only the owner can take RON or tickets out of the contract.
*/

interface IERC1155 {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

contract CAGnaval {
    // ---------------------------------------------------------------- setup
    address public owner;
    address public referee;
    IERC1155 public ticket;
    uint256 public ticketId;

    uint256 public maxTickets = 5;          // tickets per run
    uint256 public capPerTicket = 105 ether; // max golden prize per ticket (21 x 5 RON)
    uint256 public claimDelay = 1 hours;    // posting -> claims open
    uint256 public claimWeeks = 1;          // weeks to claim after the close
    // shares of the full ticket price, in hundredths of a percent
    uint256 public poolBps = 7250;          // weekly pool 72.5%
    uint256 public bonusBps = 2000;         // golden box 20%
    uint256 public feeBps = 250;            // Ronin Market fee 2.5%, already taken from what is deposited
                                            // team gets the rest: 7.5% - 2.5% fee = 5% of the price
    address public treasury;                // receives the rest of each deposit
    bool public paused;

    uint256 public constant WEEK = 7 days;
    uint256 public constant MONDAY0 = 4 days; // 1970-01-05 00:00 UTC was a Monday

    // ---------------------------------------------------------------- runs
    struct Run {
        address player;
        uint32 tickets;
        uint32 week;
        uint64 startedAt;
        bool settled;
        uint128 gold;   // golden onigiri prize won
        uint128 cap;    // capPerTicket when the run started
    }
    Run[] internal _runs;
    uint256 public bonusBox;   // RON in the golden box (includes prizes won and not yet claimed)
    uint256 public openRuns;
    mapping(address => uint256) public goldOwed; // golden prizes won and not yet claimed
    uint256 public goldPending;                  // sum of goldOwed

    // ---------------------------------------------------------------- weeks
    mapping(uint256 => uint256) public weekPool;     // RON loaded for that week
    mapping(uint256 => uint256) public weekAssigned; // RON handed out by results
    mapping(uint256 => uint256) public weekClaimed;  // RON already claimed
    mapping(uint256 => uint256) public weekRolled;   // RON moved to later weeks
    mapping(uint256 => uint256) public postedAt;     // last results posting
    mapping(uint256 => mapping(address => uint256)) public prize;
    mapping(uint256 => mapping(address => bool)) public claimed;

    // ---------------------------------------------------------------- events
    event RunStarted(uint256 indexed runId, address indexed player, uint256 tickets, uint256 week);
    event RunSettled(uint256 indexed runId, address indexed player, uint256 gold);
    event BonusFunded(address indexed from, uint256 amount);
    event BonusWithdrawn(address indexed to, uint256 amount);
    event PoolFunded(uint256 indexed week, address indexed from, uint256 amount);
    event ResultsPosted(uint256 indexed week, uint256 winners, uint256 amount);
    event ResultsVoided(uint256 indexed week, address indexed player, uint256 amount);
    event Claimed(uint256 indexed week, address indexed player, uint256 amount);
    event Rolled(uint256 indexed fromWeek, uint256 indexed toWeek, uint256 amount);
    event GoldWon(uint256 indexed runId, address indexed player, uint256 amount);
    event GoldClaimed(address indexed player, uint256 amount);
    event Deposited(address indexed from, uint256 amount, uint256 week, uint256 pool, uint256 bonus, uint256 team);
    event Split(uint256 poolBps, uint256 bonusBps, uint256 feeBps, address treasury);
    event TicketSet(address ticket, uint256 ticketId);
    event ItemsWithdrawn(address indexed token, uint256 id, address indexed to, uint256 amount);
    event Config(uint256 maxTickets, uint256 capPerTicket, uint256 claimDelay, uint256 claimWeeks);
    event RefereeSet(address referee);
    event OwnerSet(address owner);
    event Paused(bool paused);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyReferee() { require(msg.sender == referee, "not referee"); _; }

    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "busy"); _lock = 2; _; _lock = 1; }

    constructor(address _ticket, uint256 _ticketId, address _referee) {
        owner = msg.sender;
        treasury = msg.sender;
        ticket = IERC1155(_ticket);
        ticketId = _ticketId;
        referee = _referee;
        emit OwnerSet(msg.sender);
        emit RefereeSet(_referee);
    }

    // ================================================================ weeks
    function currentWeek() public view returns (uint256) {
        return (block.timestamp - MONDAY0) / WEEK;
    }
    function weekStartsAt(uint256 week) public pure returns (uint256) { return MONDAY0 + week * WEEK; }
    function weekEndsAt(uint256 week) public pure returns (uint256) { return MONDAY0 + (week + 1) * WEEK; }
    function claimEndsAt(uint256 week) public view returns (uint256) { return weekEndsAt(week) + claimWeeks * WEEK; }

    // ================================================================ runs
    /// Player starts a run by sending tickets here. `data` is ignored.
    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata)
        external returns (bytes4)
    {
        require(msg.sender == address(ticket), "not our ticket");
        require(id == ticketId, "wrong item");
        require(!paused, "paused");
        require(value >= 1 && value <= maxTickets, "1 to maxTickets tickets");
        require(from != address(0), "no player");
        require(bonusFree() >= value * capPerTicket, "bonus box too low");
        openRuns += 1;

        uint256 runId = _runs.length;
        uint256 w = currentWeek();
        _runs.push(Run(from, uint32(value), uint32(w), uint64(block.timestamp), false, 0, uint128(capPerTicket)));
        emit RunStarted(runId, from, value, w);
        return this.onERC1155Received.selector;
    }

    /// Batches are not a way to start a run.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        revert("one item at a time");
    }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == 0x01ffc9a7 /* ERC165 */ || i == 0x4e2312e0 /* ERC1155Receiver */;
    }

    /// Referee closes a run. `gold` is the golden onigiri prize in RON (0 if none).
    function settleRun(uint256 runId, uint256 gold) external onlyReferee nonReentrant {
        Run storage r = _runs[runId];
        require(!r.settled, "already settled");
        require(gold <= uint256(r.tickets) * r.cap, "over the cap");
        r.settled = true;
        r.gold = uint128(gold);
        openRuns -= 1;
        if (gold > 0) {
            goldOwed[r.player] += gold;
            goldPending += gold;
            emit GoldWon(runId, r.player, gold);
        }
        emit RunSettled(runId, r.player, gold);
    }

    function runCount() external view returns (uint256) { return _runs.length; }
    function getRun(uint256 runId) external view returns (Run memory) { return _runs[runId]; }

    // ================================================================ bonus box
    function fundBonus() external payable {
        require(msg.value > 0, "no RON");
        bonusBox += msg.value;
        emit BonusFunded(msg.sender, msg.value);
    }

    /// Part of the box not owed to anybody yet.
    function bonusFree() public view returns (uint256) {
        return bonusBox > goldPending ? bonusBox - goldPending : 0;
    }

    /// What a player won, and whether the box can pay all of it right now.
    function goldClaimable(address player) external view returns (uint256 won, bool payableNow) {
        won = goldOwed[player];
        payableNow = won > 0 && !paused && bonusBox >= won;
    }

    /// Player takes the golden prizes won, always in full. If the box cannot
    /// cover the whole amount, it stays pending until the box is refilled.
    function claimGold() external nonReentrant {
        require(!paused, "paused");
        uint256 won = goldOwed[msg.sender];
        require(won > 0, "nothing to claim");
        require(bonusBox >= won, "box being refilled");
        goldOwed[msg.sender] = 0;
        goldPending -= won;
        bonusBox -= won;
        _send(msg.sender, won);
        emit GoldClaimed(msg.sender, won);
    }

    function withdrawBonus(uint256 amount, address to) external onlyOwner nonReentrant {
        require(amount <= bonusFree(), "owed to players");
        bonusBox -= amount;
        _send(to, amount);
        emit BonusWithdrawn(to, amount);
    }

    // ================================================================ sales
    /// Owner sends ticket sales as received from the market (fee already taken).
    /// Each part is a share of the full price: deposit / (1 - fee) x share.
    /// `week` is the pool that gets its part.
    function deposit(uint256 week) external payable nonReentrant {
        require(msg.value > 0, "no RON");
        require(week >= currentWeek(), "week already closed");
        uint256 net = 10000 - feeBps;
        uint256 pool = msg.value * poolBps / net;
        uint256 bonus = msg.value * bonusBps / net;
        uint256 team = msg.value - pool - bonus;
        weekPool[week] += pool;
        bonusBox += bonus;
        emit Deposited(msg.sender, msg.value, week, pool, bonus, team);
        if (team > 0) _send(treasury, team);
    }

    // ================================================================ weekly pool
    function fundPool(uint256 week) external payable {
        require(msg.value > 0, "no RON");
        require(week >= currentWeek(), "week already closed");
        weekPool[week] += msg.value;
        emit PoolFunded(week, msg.sender, msg.value);
    }

    /// Referee posts winners of a closed week. Can be sent in several parts.
    function postResults(uint256 week, address[] calldata players, uint256[] calldata amounts)
        external onlyReferee
    {
        require(week < currentWeek(), "week not over");
        require(block.timestamp < claimEndsAt(week), "claim time over");
        require(players.length == amounts.length, "length mismatch");
        uint256 sum;
        for (uint256 i = 0; i < players.length; i++) {
            require(players[i] != address(0), "zero address");
            require(!claimed[week][players[i]], "already claimed");
            prize[week][players[i]] += amounts[i];
            sum += amounts[i];
        }
        require(weekAssigned[week] + sum <= weekPool[week] - weekRolled[week], "more than the pool");
        weekAssigned[week] += sum;
        postedAt[week] = block.timestamp;
        emit ResultsPosted(week, players.length, sum);
    }

    /// Owner removes a wrong prize before it is claimed.
    function voidResult(uint256 week, address player) external onlyOwner {
        require(!claimed[week][player], "already claimed");
        uint256 a = prize[week][player];
        prize[week][player] = 0;
        weekAssigned[week] -= a;
        emit ResultsVoided(week, player, a);
    }

    function claimable(address player, uint256 week) public view returns (uint256) {
        if (claimed[week][player] || paused) return 0;
        if (postedAt[week] == 0 || block.timestamp < postedAt[week] + claimDelay) return 0;
        if (block.timestamp >= claimEndsAt(week)) return 0;
        return prize[week][player];
    }

    function claim(uint256 week) external nonReentrant {
        uint256 a = claimable(msg.sender, week);
        require(a > 0, "nothing to claim");
        claimed[week][msg.sender] = true;
        weekClaimed[week] += a;
        _send(msg.sender, a);
        emit Claimed(week, msg.sender, a);
    }

    /// What a week still holds that nobody can claim any more (or never could).
    function leftover(uint256 week) public view returns (uint256) {
        uint256 kept = weekPool[week] - weekRolled[week];
        if (block.timestamp >= claimEndsAt(week)) return kept - weekClaimed[week];
        if (week < currentWeek()) return kept - weekAssigned[week]; // never handed out
        return 0;
    }

    /// Owner or referee moves leftover RON of a week into an open week's pool.
    function rollover(uint256 fromWeek, uint256 toWeek) external {
        require(msg.sender == owner || msg.sender == referee, "not allowed");
        require(toWeek >= currentWeek(), "target week closed");
        // before the claim deadline only the part results did not hand out can move,
        // and only once results are posted (so a pool is never moved by mistake first)
        require(block.timestamp >= claimEndsAt(fromWeek) || postedAt[fromWeek] != 0, "post results first");
        uint256 a = leftover(fromWeek);
        require(a > 0, "nothing to move");
        weekRolled[fromWeek] += a;
        weekPool[toWeek] += a;
        emit Rolled(fromWeek, toWeek, a);
    }

    // ================================================================ payments
    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    receive() external payable { revert("use deposit, fundBonus or fundPool"); }

    // ================================================================ owner
    function withdrawTickets(uint256 amount, address to) external onlyOwner {
        ticket.safeTransferFrom(address(this), to, ticketId, amount, "");
        emit ItemsWithdrawn(address(ticket), ticketId, to, amount);
    }

    /// Any ERC-1155 item held here (e.g. tickets of a previous collection).
    function withdrawItems(address token, uint256 id, uint256 amount, address to) external onlyOwner {
        IERC1155(token).safeTransferFrom(address(this), to, id, amount, "");
        emit ItemsWithdrawn(token, id, to, amount);
    }

    /// Switch to another ticket collection/item (e.g. from the test drinks to the
    /// CAGnaval tickets). Pools, box and history stay.
    function setTicket(address _ticket, uint256 _ticketId) external onlyOwner {
        require(openRuns == 0, "wait for open runs");
        ticket = IERC1155(_ticket);
        ticketId = _ticketId;
        emit TicketSet(_ticket, _ticketId);
    }

    function setSplit(uint256 _poolBps, uint256 _bonusBps, uint256 _feeBps, address _treasury) external onlyOwner {
        require(_feeBps <= 2000, "fee too high");
        require(_poolBps + _bonusBps + _feeBps <= 10000, "over 100%");
        require(_treasury != address(0), "zero address");
        poolBps = _poolBps;
        bonusBps = _bonusBps;
        feeBps = _feeBps;
        treasury = _treasury;
        emit Split(_poolBps, _bonusBps, _feeBps, _treasury);
    }

    function ticketsHeld() external view returns (uint256) {
        return ticket.balanceOf(address(this), ticketId);
    }

    function setConfig(uint256 _maxTickets, uint256 _capPerTicket, uint256 _claimDelay, uint256 _claimWeeks)
        external onlyOwner
    {
        require(_maxTickets >= 1 && _maxTickets <= 20, "maxTickets 1-20");
        require(_capPerTicket > 0, "cap 0");
        require(_claimDelay <= 3 days, "claimDelay too long");
        require(_claimWeeks >= 1 && _claimWeeks <= 8, "claimWeeks 1-8");
        maxTickets = _maxTickets;
        capPerTicket = _capPerTicket;
        claimDelay = _claimDelay;
        claimWeeks = _claimWeeks;
        emit Config(_maxTickets, _capPerTicket, _claimDelay, _claimWeeks);
    }

    function setReferee(address _referee) external onlyOwner { referee = _referee; emit RefereeSet(_referee); }
    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    /// Owner frees a run the referee never closed (server down, etc.). Pays nothing.
    function cancelRun(uint256 runId) external onlyOwner {
        Run storage r = _runs[runId];
        require(!r.settled, "already settled");
        require(block.timestamp >= r.startedAt + 1 days, "give the referee a day");
        r.settled = true;
        openRuns -= 1;
        emit RunSettled(runId, r.player, 0);
    }
}

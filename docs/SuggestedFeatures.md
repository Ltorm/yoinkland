# YoinkLand — Suggested Features (not yet implemented)

A running list of ideas we've discussed or that fall out naturally from what's
already built. Status tags: **TODO** (nothing yet), **PARTIAL** (some pieces
exist), **IDEA** (sketch only). This is a wishlist/roadmap, not a commitment.

---

## Naval

### ⚓ Battleship — _the big one_ **TODO**

A large capital warship that outclasses the standard warship.

- **Health:** **3×** a normal warship's HP.
- **Fire rate:** shoots at enemy ships **25% faster** (attack cooldown ×0.8).
- **Size/shape:** **4× larger** than a normal ship, with an **oblong**
  (elongated) hull instead of the round/compact warship footprint.
- **Mobile trebuchet:** ships **with a deck-mounted mobile trebuchet** — it can
  lob boulders (reusing the existing Trebuchet/Boulder mechanic) while the
  battleship moves, giving it ship-to-shore siege from the water.

_Implementation notes:_ new `UnitType.Battleship` + config entries
(`unitInfo` health, `attackCooldown`, build cost), an oblong sprite + a larger
hit/render footprint, and a bundled mobile-trebuchet sub-unit (or a "can fire
boulders" flag wired to `BoulderExecution`). Suggested balancing knobs to set
later: build cost (high), move speed (slower than a warship), and gold upkeep.

### Other naval ideas **IDEA**

- **Submarine** — stealth unit, surfaces to attack, weak to nothing while
  submerged but limited firing windows.
- **Transport escort** — warships auto-escort nearby friendly transport ships.
- **Naval mines** — cheap area-denial placed in chokepoints.

---

## Siege / Land warfare

- **Mobile trebuchet (standalone)** **PARTIAL** — the static trebuchet + boulder
  flight/blast already exist; a wheeled version that can reposition would pair
  with the battleship and open up land sieges.
- **Custom siege sprites** **TODO** — bespoke art for the trebuchet, boulder,
  and water splash (currently icon-based / synthesized FX).
- **No trebuchet on your lord (anti-grief)** **TODO** — once you surrender to
  someone, your trebuchet can't target that lord (or their land), mirroring the
  existing "a vassal can't attack/nuke its lord" rule so surrendering can't be
  used to grief the lord with boulders. Block it in `BoulderExecution`/the fire
  intent the same way attacks/nukes are gated by `vassalLord()`.

---

## Territory & economy

- **Land sale polish** **PARTIAL** — core buy/sell/counter + lasso UI shipped.
  Remaining: replace the counter-price `window.prompt` with an inline panel
  input; show a notice when a lasso exceeds the 1,500-tile cap (currently
  silently truncated); optional auto-expire timer shown on the offer card.
- **Land leasing / rent** **IDEA** — rent a parcel to a neighbor for gold per
  tick instead of an outright sale.
- **Resource/troop trade offers** **IDEA** — extend the offer/counter handshake
  (already generalized for land sales) to trade gold↔troops.
- **Oil drilling** **TODO** — a buildable oil derrick that generates passive gold
  income over time. Place it on qualifying tiles (e.g. designated oil-field tiles
  on land, or offshore on water near your coast), where it produces a steady gold
  trickle while it stands. Captured/destroyed if the tile is lost, making oil
  fields contested map objectives. _Implementation notes:_ new
  `UnitType.OilDerrick` + config (build cost, gold-per-tick yield, optional
  finite reserve that depletes), an oil-field tile/terrain mask or a placement
  rule, a derrick sprite, and a tick hook that credits the owner's gold. Could
  reuse the land-bridge offshore-placement pattern for water rigs.

---

## Matchmaking & social

- **Group-vs-group matchmaking** **PARTIAL** — party-cohesion team assignment is
  done; still needs the **server-side queue** and a **party/lobby UI** to invite
  friends and queue as a group.
- **In-game party voice/text presence** **IDEA** — show who's on your team and a
  quick-ping system.

---

## Polish / quality of life

- **Sound mix pass** **IDEA** — cooldown so rapid land-offer cues don't stack;
  hook the synthesized splash/boom into the SFX volume slider.
- **Radial menu loadout** **IDEA** — let players pick which actions occupy the
  wheel slots (we just moved Sell Land into the old Delete-Unit slot by hand).
- **Map/Compact-size integrity check on load** **IDEA** — a build-time check that
  every `.bin` matches `width×height` (would have caught the autocrlf corruption
  before it hit a game).

---

_Add new ideas here as they come up; promote items to GitHub issues when we're
ready to actually build them._

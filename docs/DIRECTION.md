# DIRECTION — scope beyond PRD v1.1

Captured 2026-07-31, from the project owner. **These are intent, not yet spec.**
Several of them deliberately reverse decisions in PRD §1.4, which is the owner's
call to make — but the reversals have consequences that need to be designed
rather than assumed, and those are noted here so they are not discovered later.

---

## 0. TONE — the most load-bearing note here

> "I do not want fantasy — that is what Dota and LoL are doing. I also do not
> want super real combat like CoD. Something cool and fun, fresh, unexpected, in
> the middle. I imagine a watergun might be fun, and a glitch bomb where the
> enemies that are hit cannot use their controls for a few seconds and freak
> out."

**This is the decision PRD §11 was missing.** §11 specified a *rendering system*
(flat-shaded, desaturated, emissive accents) but never said what the world
*is* — and "not slop" is unachievable without that, because slop is what you get
when a style has a technique but no point of view.

Two rejected poles, and what they rule out:

| Rejected | What it takes off the table |
|---|---|
| **Fantasy (Dota / LoL)** | Swords, magic, robes, runes, ancient-evil framing. Also the *naming* register: no "Arcane", no "Soulrender". |
| **Military realism (CoD)** | Ballistics fetish, brown-grey palette, tactical gear, gun-porn reload animations, war as subject matter. |

The two examples given are not random — they point at the same place from
different sides:

- **A watergun** is a *toy*. It implies play rather than combat, saturated
  colour, summer-backyard energy, and weapons that read as fun to be hit by.
- **A glitch bomb** is *digital*. It implies the world is synthetic and knows
  it, that the rules can be tampered with, and that the comedy comes from
  systems misbehaving.

**Toys inside a simulation that can be tampered with.** Playground objects with
real physical weight, in a world whose seams are visible on purpose. That
reading is worth committing to because it makes concrete decisions downstream:
saturation is allowed and even wanted (which is a genuine revision of §11's
"desaturated everything except teams/souls"), damage should read as *soaking,
tagging, splattering* rather than wounding, and the failure states are comic
rather than grim.

It also resolves the naming register. OVRRUN and LANEBREAKR both read slightly
military; a toys-and-glitches world wants something with more play in it. Worth
revisiting alongside the repo rename.

### The GLITCH BOMB, specifically

This is a strong idea and the strongest clip generator proposed so far — losing
control is funny to watch, funny to land, and *legible with no context*, which
is Pillar P4 exactly. One design bar it has to clear:

**It must be funny to be hit by, not only funny to land.** Removing a player's
control is among the most hated mechanics in games when it is long, unclear, or
lethal — and among the most beloved when it is short, telegraphed, and
survivable. Concretely, that means:

- **Short.** 1.5–2s, not 4. Long enough to lose a duel, not long enough to
  resent.
- **Telegraphed.** A visible arm and a visible radius, so being hit is a read
  you lost rather than a thing that happened to you.
- **Non-lethal by itself.** It should not deal meaningful damage. It creates the
  opening; someone still has to take it.
- **Spectacular on the receiving end.** Chromatic aberration, input lag,
  scrambled HUD, the character visibly stuttering. The *victim's* screen should
  be the best-looking thing in the game for two seconds.
- **Never a total lockout.** Scramble or invert, do not freeze. A player who can
  still flail can still get lucky, and that near-miss is the clip.

**Accessibility note:** input inversion and heavy screen distortion cause real
problems for some players (motion sensitivity, motor impairments). A reduced
-effects option that keeps the *mechanical* penalty while dropping the visual
distortion is table stakes, not polish.

### What this changes in the existing build

- §11's "desaturated everything" is revised: the environment can carry colour,
  as long as teams/souls/objectives still win the contrast fight.
- Weapon feel work should aim at *satisfying and toy-like*, not *authentic*.
  The current SMG synthesis is a realistic gunshot and is now off-brief.
- The four MVP heroes (VOLT/BULWARK/HALO/RIFT) are named and framed neutrally
  enough to survive, but their kits should be re-read against this: a launcher
  that fires paint or foam is the same code and a different game.

## 1. The goal, restated

> "A mix of fun with friends."

The centre of gravity moves from *a good 3v3* to *a place you and your friends
hang out and make things happen*. That is a different product than PRD v1.0
described, and it changes what "done" means: the win condition stops being
"the match is balanced" and becomes "people come back with the same people".

Everything below serves that.

## 2. Communication and emotes

- In-game comms with **teammates**. With **enemies: optional** (opt-in, mutable).
- **Emotes are very important.**

*Assessment: the cheapest and most aligned item on this list.* PRD §9 is already
built around clip generation, and emotes are among the highest clip-per-byte
features in the medium — the taunt over a body, the mistimed dance, the whole
team emoting on a won objective. They also carry social meaning with no voice
chat (§1.4 rules that out) and no text-chat moderation burden if wheel-based.

**Note:** enemy-facing comms is the item that needs the most care, not the most
code. It is the surface where harassment happens, and "optional" has to mean
default-off-and-per-player-mutable, not a settings-menu toggle nobody finds.

## 3. Economy, marketplace, and cash-out

- "Very good in-game economy."
- A marketplace where people **buy and sell items**.
- Players can **cash out the in-game currency**.

*Assessment: this is the item with real consequences, and two of them are
structural rather than a matter of effort.*

**(a) Cash-out is a regulated activity, not a feature flag.** Letting players
convert an in-game balance into money generally engages money-transmission /
e-money rules (US state-by-state MTL, EU e-money), and pulls in KYC/AML
obligations. If any item can be acquired by chance and then sold for money,
several jurisdictions treat that as gambling regardless of intent. The reason
Valve's marketplace works the way it does — items trade freely, wallet funds
never leave the platform — is precisely to stay on one side of that line. This
is a decision to take with a lawyer before it is a decision to take with an
architecture, and it should be scoped as such. It is not a reason not to do it;
it is a reason not to build it *incidentally*.

**(b) Real value plus invisible bot backfill is a farming exploit by
construction.** PRD §10.5 and §14 make bot backfill the answer to empty
lobbies — invisible, always available, "the game is never unplayable". The
moment anything earned in a match converts to money, a match against bots is a
money printer, and the feature that keeps the game alive at low population
becomes the feature that drains it. These two cannot both be true as written.
Resolutions exist (meta-currency earned only in verified human matches; earnings
gated on a human-verified opponent count; bots excluded from all meta rewards)
but one has to be chosen deliberately.

**(c) Souls must not be the cash-out currency.** §7's souls are a *per-match*
resource whose entire balance — 4,500 per player, the item ladder, SURGE — is
tuned to a 12-minute arc. If souls carry real value out of the match, every
balance number in `balance.ts` becomes a real-money balance number, and the
economy stops being tunable. The meta economy needs its own currency, earned on
a different axis (time, outcome, achievement), with no exchange rate to souls.

## 4. Progression: skill, levels, leaderboards

- A **skill** system, **level-up**, and **leaderboards**.

*Assessment: a direct reversal of PRD §1.4, which cuts "Ranked ladder / MMR /
seasons" and "Accounts, progression, cosmetics, monetization". Fine to reverse —
but §1.4's cuts were load-bearing for something else.*

**Accounts become mandatory, and accounts were the thing §9.7 was designed
around.** The share-a-link acquisition path (`GET /r/<id>`, `?r=<code>` join)
works *because* there is no signup between a clip and a match. Adding a required
account in front of that is exactly the friction the browser-first thesis (Q4)
exists to avoid.

**The resolution is guest-first, not account-first:** play instantly as a guest,
with progression accruing to a local identity that can be *claimed* into a real
account later. You lose nothing by never signing up except persistence, and the
moment a player cares about their level or their leaderboard place, claiming is
the natural next click rather than a gate.

Note also that §12/M8's balance gate already found per-hero win rate is close to
unmeasurable at a 4-hero roster (a hero is on both teams in 9/16 of comps). A
player-facing skill rating has the same shape of problem at low population and
needs its own thinking, not a copy of the balance approach.

## 5. Livestream, creation, clips

- Built to be played **on livestream**.
- Players **create their own experiences in our world**.
- Target: **thousands of viral clips**.

*Assessment: the first and third are already the PRD's spine — §9 is the viral
layer and P4 is the legibility pillar. The middle one is new and is the largest
item on this page.*

"Create their own experiences" implies user-generated content: custom rooms,
rule modifiers, maybe map variants. That is a platform, not a mode. It is also
the single highest-leverage retention feature on this list, because it converts
players into content supply. Worth scoping seriously and separately.

## 6. Art direction

> "Not AAA graphics, but they should be good and not look like low-effort AI
> slop. We need to find a good balance."

*Assessment: the most useful note here, because it sets a bar that the current
build does not meet and that §11 alone does not describe.*

§11 specifies flat-shaded low-poly with hard emissive accents and a desaturated
palette, which is the right *system*. What it does not specify is the thing that
separates "deliberate stylisation" from "default materials": a consistent
silhouette language, intentional negative space, lighting that reads as authored
rather than as one directional light, and surface detail that is cheap but
non-uniform. The current build is grey boxes with edge lines — correct for M0,
and nowhere near the bar.

This needs an actual art direction pass with references, not more constants.

---

## What this means for the plan

None of §2–§6 is in PRD v1.1's milestone list. The honest sequencing question is
whether they come *before* M3 (heroes, bots, a winnable match) or after, and the
answer is mostly after — with one exception:

- **Emotes and the ping/comms wheel should be pulled forward.** §1.4 already
  makes pings the fog-of-war replacement, so a wheel has to exist anyway; emotes
  ride the same input, the same wire bits, and the same UI. Building it once is
  much cheaper than building pings now and emotes later.
- **Accounts, meta-currency, marketplace, cash-out, progression and UGC all
  depend on a server that does not exist until M4.** Designing them now is
  useful; building them now is not.

Recorded as BACKLOG items with this file as the rationale.

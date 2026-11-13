---
name: Music Deck
description: A DJ booth for one GM, in a dark corner of Foundry VTT's Playlists tab.
colors:
  booth-black: "#1f2026"
  console-panel: "#272830"
  seam: "#3a3b46"
  lamp-white: "#e8e6e3"
  readout-grey: "#c4c2cc"
  chrome-grey: "#a3a1ad"
  booth-amber: "#e0a65a"
  deck-a-blue: "#6fb1e8"
  deck-b-violet: "#c58be8"
  ambient-green: "#7cc79a"
  sfx-coral: "#e8846f"
  table-rose: "#ec8db6"
  online-teal: "#45c9cf"
  panic-red: "#f5625f"
  ink-on-colour: "#111318"
typography:
  title:
    fontFamily: "var(--font-body), Signika, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "var(--font-body), Signika, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.3
  readout:
    fontFamily: "var(--font-body), Signika, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
    fontFeature: "tnum"
  meta:
    fontFamily: "var(--font-body), Signika, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
  label:
    fontFamily: "var(--font-body), Signika, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.02em"
  deck-letter:
    fontFamily: "var(--font-body), Signika, sans-serif"
    fontSize: "14px"
    fontWeight: 800
    lineHeight: 1
rounded:
  key: "5px"
  row: "6px"
  card: "8px"
  pill: "999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
components:
  deck-card:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.lamp-white}"
    rounded: "{rounded.card}"
    padding: "8px"
  deck-letter-a:
    backgroundColor: "{colors.deck-a-blue}"
    textColor: "{colors.ink-on-colour}"
    typography: "{typography.deck-letter}"
    rounded: "{rounded.key}"
    size: "26px"
  deck-letter-b:
    backgroundColor: "{colors.deck-b-violet}"
    textColor: "{colors.ink-on-colour}"
    typography: "{typography.deck-letter}"
    rounded: "{rounded.key}"
    size: "26px"
  sfx-pad:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.lamp-white}"
    rounded: "{rounded.card}"
    padding: "6px"
  sfx-pad-playing:
    backgroundColor: "{colors.sfx-coral}"
    textColor: "{colors.ink-on-colour}"
    rounded: "{rounded.card}"
  button-fade:
    backgroundColor: "{colors.booth-amber}"
    textColor: "{colors.ink-on-colour}"
    typography: "{typography.label}"
    rounded: "{rounded.row}"
    padding: "4px 10px"
  button-panic:
    backgroundColor: "transparent"
    textColor: "{colors.panic-red}"
    typography: "{typography.label}"
    rounded: "{rounded.row}"
    padding: "3px 9px"
  button-panic-on:
    backgroundColor: "{colors.panic-red}"
    textColor: "{colors.ink-on-colour}"
  chip:
    backgroundColor: "{colors.seam}"
    textColor: "{colors.lamp-white}"
    typography: "{typography.label}"
    rounded: "{rounded.key}"
    padding: "2px 7px"
  chip-on:
    backgroundColor: "{colors.booth-amber}"
    textColor: "{colors.ink-on-colour}"
  queue-row:
    backgroundColor: "transparent"
    textColor: "{colors.lamp-white}"
    typography: "{typography.body}"
    rounded: "{rounded.row}"
    padding: "5px 6px"
    height: "30px"
  input-search:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.lamp-white}"
    rounded: "{rounded.row}"
    padding: "6px 9px"
    height: "30px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.chrome-grey}"
    typography: "{typography.body}"
    padding: "9px 0"
  tab-on:
    textColor: "{colors.lamp-white}"
---

# Design System: Music Deck

## Overview

**Creative North Star: "The Booth at Night"**

Music Deck is a DJ booth in a dim room. The GM sits in the dark with the table lit low, and the screen has to read like well-made hardware at arm's length: dark, quiet surfaces, and a few things that glow because they matter. The deck colours, the live readouts and the loud states (pending, muted, Panic, "can't hear") are the light sources. Everything else is the booth itself, and stays out of the way.

It lives inside Foundry VTT's Playlists sidebar, a column roughly 300px wide, and in a pop-out "big mixer" at 440px and up. That width sets the density: one column, short labels, controls that reveal on hover in lists, and no second column until the pop-out has room. The reference is Pioneer rekordbox: deck colours you read instantly, hot-cue pads, and state you understand at a glance. The Stream Deck+ uses the same hues, letters and names, so the two must stay twins.

Controls are tactile. Pads and deck keys look pressable, with a lit edge and a small press-down; the chrome around them (tabs, rows, footers) is flat and tonal. There is no parchment, no medieval type and no fantasy ornament: the game world lives in the music, not in the chrome.

**Key Characteristics:**
- Dark tonal layering (three steps: booth, panel, seam), no shadows inside the tab.
- Four channel identities (Deck A, Deck B, Ambient, SFX), each a hue plus a letter or icon, never hue alone.
- One warm accent (Booth Amber) for focus, the active tab, Fade and anything pending.
- Live readouts in Lamp White or Readout Grey at 13px and up; Chrome Grey only for labels and hints.
- Pressable pads and keys, flat everything else.

## Colors

A charcoal booth with four channel lamps and one amber work light.

### Primary
- **Booth Amber** (`booth-amber`): the one accent. Keyboard focus rings, the active tab underline, the Fade button, the selected chip, the filled "next" tag on a queue's cued track, a deck that is cued and waiting, "can't hear", "Pair deck", and every other *pending* state. It is never a channel colour, and slider caps don't use it.

### Channel colours
These four are a set. They match the Stream Deck plugin's key colours (`deck-plugin/src/feedback.ts`, `manifest.json`) and must change there too if they ever change here.
- **Deck A Blue** (`deck-a-blue`): Deck A's letter tile, progress bar, playing row and "＋A" chips.
- **Deck B Violet** (`deck-b-violet`): the same roles for Deck B.
- **Ambient Green** (`ambient-green`): ambient layer toggles, the active sound scene, the Ambient volume fill.
- **SFX Coral** (`sfx-coral`): SFX pads' lit edge, a pad that is playing, the SFX volume fill.

### Play modes
- **Table Rose** (`table-rose`) and **Online Teal** (`online-teal`): Table play and Online play. Each colours its mode button (a 16% tint, a 1px border, text and icon in the colour) and the hearing dot under it, so the mode reads from the colour as well as its icon and label. They are the two hues left clear of the channels and the accent; never use them for anything else.

### Status
- **Panic Red** (`panic-red`): Fade all / Panic and its strip, a muted channel's name and icon, battle music. Redder than SFX Coral on purpose, and always paired with an icon and a label so it never relies on hue.

### Neutral
- **Booth Black** (`booth-black`): the tab background.
- **Console Panel** (`console-panel`): cards, rows on hover, pads, inputs, the segmented control.
- **Seam** (`seam`): dividers, slider tracks, neutral chips, the toggle's off track.
- **Lamp White** (`lamp-white`): titles, names, values (11.8:1 on Console Panel).
- **Readout Grey** (`readout-grey`): secondary live readouts such as elapsed time, percents and durations (8.3:1 on Console Panel).
- **Chrome Grey** (`chrome-grey`): labels, hints, empty states and resting tab text (5.8:1 on Console Panel). Never for a value the GM reads mid-session.
- **Ink on Colour** (`ink-on-colour`): text and icons on any channel, amber or red fill (7:1 or better on each).

### Named Rules
**The Lamp Rule.** A channel hue is a lamp: it marks *which* channel, never *how important*. Importance comes from Booth Amber (pending), Panic Red (danger) and fill versus outline.

**The Letter Rule.** No colour stands alone. Deck A carries "A", Deck B carries "B", Ambient carries the rain-cloud icon, SFX the bell icon. If you can't tell two channels apart in greyscale, it isn't done.

**The Twin Rule.** Hues, letters, names and pad numbers match the Stream Deck exactly. Change one, change both.

## Typography

**Body Font:** Foundry's UI font (`--font-body`, Signika) at Foundry's sizes.
**Numerals:** the same face with tabular figures (`font-variant-numeric: tabular-nums`) for every time, percent and count.

**Character:** One humanist sans, used plainly. Hierarchy comes from weight, size steps of 1–2px and colour (Lamp White, Readout Grey, Chrome Grey), not from extra families.

### Hierarchy
- **Deck letter** (800, 14px): the A and B tiles. The heaviest thing on screen, because it's the fastest thing to read.
- **Title** (600, 14px, 1.25): the track on each deck, pad names in the big mixer.
- **Body** (400, 13px, 1.3): queue rows, Library rows, layer names, tabs.
- **Readout** (500, 13px, tabular): elapsed / total time, level percents, durations, player counts. Readout Grey or Lamp White.
- **Meta** (400, 12px): a Library row's folder, a pad's sub-line, hints in dialogs.
- **Label** (600, 11px, +0.02em): chips, the Fade button, status chips. Short words only, never sentences, never a live value.

### Named Rules
**The Arm's-Length Rule.** Anything the GM reads mid-session (what's playing, how far in, levels, who can't hear) is 13px or larger in Lamp White or Readout Grey. 11px Chrome Grey is for labels that never change.

## Layout

One column inside the sidebar: the **Now** block is pinned at the top (status line, who hears it, then a **Volumes** section with the level strips and ambient line, then a **Decks** section with Deck A, the crossfader and Deck B); four tabs (Music, Ambient, SFX, Library) switch the scrolling view below; a footer holds the undo strip (after a remove), the way back to the classic view and the pop-out.

Every part folds. Volumes and Decks each have a header (chevron and name) that folds the section and, while folded, shows a one-line summary on the right ("Music 81 · Ambient muted · SFX 88", "A on air · Tavern at Dusk"), so state stays readable at a glance. A chevron at the end of the tab bar folds the tab's list; choosing any tab opens it again. Folds are remembered per browser. The pop-out big mixer is the same view with more room: wider pads and, at its larger sizes, room for cue chips on each deck.

Spacing is a tight 2/4/6/8/10/14 step scale. Cards and rows pad 6–8px, sections separate with a 1px Seam line and 8–10px of space. Grids are fixed-track where alignment matters: deck cards (letter, info, controls), level strips (name, slider, percent, mute), queue rows (grip, number, name, duration or hover actions).

Lists reveal per-row actions on hover and on keyboard focus (`:focus-within`), so a resting list stays calm. The reserved cue slots (see Components) add a row *below* existing content, never a new column.

## Elevation & Depth

Flat inside the tab. Depth is tonal: Booth Black, then Console Panel, then Seam, each a step lighter. The Now block sits on a faint vertical gradient from Console Panel to Booth Black to separate it from the scrolling view. The only drop shadow is on the players' sound banner, which floats over the Foundry canvas.

Pressable controls (pads, deck keys) get depth from a lit edge (a 3px top border in the channel colour) and a press-down (`scale(.96)` on `:active`), not from shadows.

### Shadow Vocabulary
- **Banner float** (`box-shadow: 0 4px 16px rgba(0, 0, 0, .45)`): the players' "click to turn on sound" banner only.

### Named Rules
**The Flat Booth Rule.** No shadows inside the tab. If something needs to stand out, change its tone, its edge or its fill.

## Shapes

Small, consistent radii that read as hardware keys rather than web cards: 5px for keys, chips and icon buttons; 6px for rows, inputs and the segmented control; 8px for deck cards and pads; full pills for status chips (Stream Deck link, can't hear). Square-ish deck letter tiles, square pads (`aspect-ratio: 1`). No circles except status dots and the toggle knob.

## Components

### Deck card
*The heart of the booth: what's on each deck, at a glance.*
- **Shape:** Console Panel, 8px radius, a three-track grid: letter tile (26px), info, controls.
- **Letter tile:** 28px. Filled in the deck colour with its letter in Ink on Colour while the players hear the deck; outlined (2px ring, letter in the deck colour) when the crossfader, mute or Panic has it off air. Fill versus outline is the colour-free cue.
- **On air:** a small filled tag after the title while the deck is audible *and* playing, the way rekordbox marks the deck on air.
- **Info:** title (14px 600, ellipsis), then a readout line (13px 500 tabular) led by a state glyph: playing (Lamp White, play glyph in the deck colour), paused (Readout Grey, pause glyph), cued (Booth Amber, dot glyph, "Cued · ready"), empty (Chrome Grey). Then a 4px progress bar in the deck colour.
- **Fading out:** the title, bar and buttons dim with the crossfader (`--md-presence`); the letter tile and the readout never dim, so a faded deck stays readable.
- **Controls:** 26px icon buttons (play/pause, next).
- **Reserved:** a cue-chip row under the progress bar for the track editor (small 5px-radius chips, each with a number or letter as well as a colour). Keep the card's grid able to take a fourth row without changing its columns.

### Crossfader
- A and B keys (18px outlined letter keys in the deck colours), a range slider with a tall Lamp White fader cap, and the amber **Fade to B** / **Fade to A** button, which names where it's going.

### Level strip
- Fixed grid: icon + name (12px Readout Grey), slider (Lamp White cap), percent (13px Readout Grey, tabular), mute button.
- **Fill:** the track fills in its channel's colour up to the cap: Music runs Deck A blue into Deck B violet, Ambient green, SFX coral. Ambient layer sliders fill green while the layer is on and grey while it's off. The crossfader isn't a volume and stays a plain Seam track.
- **Muted:** the button's glyph changes (speaker to crossed speaker) and turns Panic Red, the name and its icon turn Panic Red, the slider dims and the percent is struck through. Never colour alone.

### Buttons
- **Icon button:** transparent, 26px square, 5px radius, Seam background on hover, 35% opacity when disabled.
- **Fade (primary):** Booth Amber fill, Ink on Colour text, 6px radius.
- **Panic:** outlined in Panic Red at rest, filled (Ink on Colour) when on, always with the power icon and a label ("Fade all" / "Bring back"). While it's on, a full-width Panic Red strip under the status line says "Everything is faded out. The table hears nothing." and the decks, fader, levels and ambient line step back to 40%.
- **Add (dashed):** full-width, 1px dashed Seam border, Chrome Grey text; for "＋ Add tracks from Library" and friends.

### Chips
- **Style:** Seam fill, 5px radius, label type. Channel "add" chips (＋A, ＋B, ＋Amb, ＋SFX) take a translucent wash of their channel colour and always carry the letter or name.
- **State:** selected chips (Library source, active scene) fill solid with Booth Amber or Ambient Green and switch to Ink on Colour.
- **Scene chips:** click fades to the scene. On hover or keyboard focus a 22px round pencil badge floats on the chip's top-right corner (Seam fill, a 2px Booth Black ring to cut it from the chip, Lamp White on hover) and opens the scene editor. Right-click keeps the full menu (Edit, Update to what's playing, Delete). The scene row has 6px of top padding so the badge isn't clipped.

### Status chips
- **Play mode** (Table play / Online play): icon + label in its mode colour (Table Rose, Online Teal) on a 16% tint with a 1px border; hover fills it solid with Ink on Colour.
- **Hearing dot:** in the mode colour: solid in Table play and when every player hears in Online play, a hollow ring when no players are online. Booth Amber (gently pulsing) when someone can't hear overrides it.
- **Can't hear:** Booth Amber pill, warning icon, a count ("2 can't hear"), and a line under it naming who ("Music Test needs to click once in Foundry."). Loud on purpose.
- **Stream Deck link:** pill, icon only when connected (Ambient Green outline), dashed when offline, "Pair deck" filled in Booth Amber while pairing.

### Lists (queue, Library)
- **Row:** 32px min height, 6px radius, Console Panel on hover or keyboard focus. The playing row takes its deck's wash and colour plus a speaker icon in place of its number; the cued row gets an amber number and a filled amber "next" tag with Ink on Colour text. The tag shows only while the deck is cued, never on a playing or paused track, and the live sync keeps it and the playing row current. No coloured side borders.
- **Row actions** float over the end of the row on hover or `:focus-within` (they stay focusable at rest), so resting names keep their full width.
- **Library row:** headphone preview button (amber ring while previewing), name and meta, floating add chips.
- **Reserved:** Library cue sub-rows for the track editor sit indented under their track (the name column's left edge), one line each, with the cue's number or letter and its colour mark, and the same hover-revealed add chips. Don't put anything in that indent.

### SFX pad
*A hot-cue pad.*
- Square, Console Panel, 8px radius, a 3px SFX Coral lit top edge. Name in 13px 600, a sub-line in 11px Readout Grey (a dice icon and "3 sounds, at random" for a random pad). Hover lifts to Seam; `:active` presses to `scale(.96)`. Playing fills the pad in SFX Coral with Ink on Colour text.

### Toggle (ambient layer)
- 38×22 track, round knob. Off: Seam track, Chrome Grey knob at left. On: Ambient Green knob at right on a green wash with a green ring. The layer's name goes from Readout Grey to Lamp White 600 when on.

### Section header (fold)
- Full-width button: a 10px chevron (pointing down when open, right when folded), the section name in 12px 600 Readout Grey, and, only when folded, the summary right-aligned in 12px 500 tabular Readout Grey. No background; Lamp White on hover; `aria-expanded` carries the state.

### Undo strip
- After a queue track, ambient layer or SFX pad is removed, the footer grows one row above its links: what was done in 12px Readout Grey ("Removed “Tavern” from Deck A", ellipsised, full text in the tooltip), an **Undo** chip with a rotate-left icon, and a Redo icon button. A Seam line separates it from the links. It stays while there's anything to undo or redo, and is gone before the first remove.
- ⌘Z / Ctrl+Z and ⇧⌘Z work while focus is in the tab; after a remove, focus moves to Undo so the shortcut reaches it. A removed sound comes back with the same id, in the same place, and silent: undo never starts sound for the table.

### Tabs and segmented control
- **Tabs:** four equal columns, each with its channel's icon (music note, rain cloud, bell, folder) and label; Chrome Grey at rest, Lamp White 600 plus a 2px amber underline when on.
- **Segmented control** (Deck A / Deck B queue, Playlists / Files): Console Panel trough, the selected half a Seam fill. Deck halves carry their letter key.

### Sound banner (players)
- Fixed at the top centre of the player's screen until their first click. Console Panel, 1px Booth Amber border, Banner float shadow, a muted-speaker icon in amber, 14px text.

### Scene editor (dialog)
- Foundry's DialogV2 chrome; inside it follows this system: name field, a hint in Meta (Readout Grey), rows on Console Panel of icon + name / level slider / percent (tabular) / remove, and a search field with a magnifier for adding sounds.

## Do's and Don'ts

### Do:
- **Do** back every channel colour with its letter (A, B) or icon (rain cloud, bell). Check in greyscale.
- **Do** set live readouts at 13px or more in Lamp White or Readout Grey, with tabular figures.
- **Do** use Booth Amber for focus, the active tab, Fade and anything pending, and nowhere else.
- **Do** reveal row actions on hover *and* `:focus-within`.
- **Do** make removes undoable rather than confirmed; keep a confirm only where undo can't reach (deleting a sound scene).
- **Do** wrap pulses, slides and press-downs in `@media (prefers-reduced-motion: no-preference)`, or remove them under `reduce`. The only loop is the can't-hear pulse.
- **Do** use Font Awesome icons (Foundry ships Pro) for meaning, never emoji or Unicode stand-ins.
- **Do** scope every rule under `.md-deck-view` (or `.md-scene-editor`, `#md-sound-banner`) so Foundry's classic view keeps its own look.

### Don't:
- **Don't** use Chrome Grey (`chrome-grey`) at 11px for anything that changes during play.
- **Don't** tell two channels apart by hue alone.
- **Don't** add shadows inside the tab, gradients beyond the Now block's, or fantasy ornament (parchment, scrolls, seals, medieval fonts).
- **Don't** add a second accent colour or reuse a channel colour for importance.
- **Don't** crowd the live view with prep controls (times, fine levels, ordering live in the Library, editors and dialogs).
- **Don't** change a hue, letter or name here without changing the Stream Deck plugin to match.

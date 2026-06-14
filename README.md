# UCSD Academic Senate Committee Network

An interactive visualization of co-membership ties on the standing committees of the
UC San Diego Academic Senate. Each node is a person (sized by how many committees they sit
on that year); each edge is a shared committee. Companion to the
[UCLA committee network](https://hart-hornor-jones.github.io/ucla-committee-network/).

## Features
- **Year slider** - step through academic years; the network re-forms for each year.
- **Tie classes** (toggle, color-coded): *current* (serving together this year),
  *repeated* (served together in two or more years), *former* (served together previously,
  but not this year).
- **Search** by name; toggle node/committee labels; exclude the large governing/plenary
  bodies so the standing-committee structure stays legible.
- Drag-to-pan, scroll-to-zoom, and a hover tooltip listing each person's committees and roles.

## Develop

    npm install
    npm run dev

## Build

    npm run build

## Data
The app reads a committee-roster dataset (one row per person x committee x year), built from
UCSD Academic Senate roster sources and de-duplicated per person/committee/year.

Deployed to GitHub Pages.

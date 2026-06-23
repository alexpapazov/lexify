# Card Data

Every vocabulary card in Lexify is a row in the `cards` table. Cards are owned by a user and scoped to a language direction — they are not owned by a deck. Multiple decks can reference the same card via `deck_cards`.

---

## Core identity

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Primary key. |
| `ownerId` | UUID | The user who owns this card. |
| `sourceLanguage` | string | Language code of the **learned** language — what appears on the front (e.g. `"es"` for Spanish). |
| `targetLanguage` | string | Language code of the **native/basis** language — what appears on the back (e.g. `"en"` for English). |
| `createdAt` | timestamp | When the card was created. |
| `updatedAt` | timestamp | Last modification time. |
| `deletedAt` | timestamp \| null | Set when soft-deleted; null means the card is active. |
| `position` | number | Ordering hint within the card's language direction. |

---

## Content

| Field | Type | Description |
|---|---|---|
| `front` | string | The word or phrase in the **language being learned** (`sourceLanguage`). This is what the learner is trying to recall. Example: `"el perro"`. For cards being translated (status `pending`), this starts blank and is filled in by the AI sync. |
| `back` | string | The word or phrase in the **native/basis language** (`targetLanguage`). This is the gloss the learner already knows. Example: `"dog"`. Starts blank for pending synced cards. |
| `hints` | string[] | Optional learner-facing hint strings shown during study (e.g. contextual clues, usage notes). Normally empty. |

---

## Multiple choice

| Field | Type | Description |
|---|---|---|
| `choices` | object \| null | Cached AI-generated distractor pool. `null` until generated during the first study session. Contains: `front` (wrong source-language options), `back` (wrong target-language options), `frontSynonyms` (accepted alternate source-language answers), `backSynonyms` (accepted alternate target-language answers). |

---

## Lexical metadata

| Field | Type | Description |
|---|---|---|
| `synonymGroupId` | string \| null | Links this card to a `SynonymGroup` when multiple source-language forms share the same gloss (e.g. *el cerdo / el chancho / el puerco* all meaning "pig"). |
| `register` | string \| null | Sociolinguistic register of the front-side item (e.g. `"formal"`, `"colloquial"`, `"slang"`). |
| `region` | string \| null | Geographic variant associated with the front-side item (e.g. `"Mexico"`, `"Río de la Plata"`). |
| `acceptedFrontAlternatives` | string[] \| undefined | Additional typed answers accepted as correct for the front side — alternate phrasings of the *same* item, not synonyms. |
| `acceptedBackAlternatives` | string[] \| undefined | Same as above for the back side. |

---

## Sync origin *(only set on AI-synced cards)*

When a card is created by the language sync system — translated from a card in another language pair — these two fields record where it came from. They are `null` for cards created directly by the user.

| Field | Type | Description |
|---|---|---|
| `syncedFromLanguage` | string \| null | Language code of the source deck's learned language (e.g. `"es"` when a Spanish/English card was used to generate this card). Displayed as "Synced from: Spanish" in the card info panel. |
| `originWord` | string \| null | The exact word or phrase from the source card's `front` that was translated to produce this card (e.g. `"el perro"`). This is the raw input the AI received. Displayed as "Origin word: el perro" in the card info panel. |

The `synced_card_links` table stores the full sync relationship (source card → synced card, sync rule, translation confidence, status). Cards start with `front = ""` and `back = ""` while `status = 'pending'`; once the AI fills them in, `status` becomes `'active'` and `front`/`back` hold the translated values.

---

## SRS state (separate table)

Each card's learning progress is tracked in `card_states` (one row per card per user). This is NOT stored on the card itself — it is loaded separately by the study engine. Key fields include: `currentStepOrder`, `correctInStep`, `graduated`, `dueAt`, `intervalDays`, `ease`, `reps`, `lapses`, and more. See `features/Learning Pipeline.md` and `features/Due Now.md` for full details.

---

## Database table: `cards`

```sql
id                        UUID  PRIMARY KEY
owner_id                  UUID  NOT NULL  -- references auth.users
source_language           TEXT  NOT NULL
target_language           TEXT  NOT NULL
front                     TEXT  NOT NULL
back                      TEXT  NOT NULL
hints                     TEXT[]
choices                   JSONB
position                  INTEGER
synonym_group_id          UUID
register                  TEXT
region                    TEXT
accepted_front_alternatives TEXT[]
accepted_back_alternatives  TEXT[]
synced_from_language      TEXT            -- null for user-created cards
origin_word               TEXT            -- null for user-created cards
deleted_at                TIMESTAMPTZ
created_at                TIMESTAMPTZ
updated_at                TIMESTAMPTZ
```

Row-level security: all columns are readable and writable only by the `owner_id` user.

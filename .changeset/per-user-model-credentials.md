---
"@i-bot/types": minor
"@i-bot/db": minor
---

Per-user (multi-tenant) model credentials: each user stores their OWN model API key; the platform never lends its key.

- **types**: `ModelCredentialsView` — the masked read shape the settings API returns. It carries `configured`, a last-4 `keyHint` (e.g. `····KeUy`), an optional `baseUrl`, and an optional `defaultModel` (prefills new-bot creation). The plaintext key is never part of the contract — it's write-only from the UI's side and lives encrypted at rest.
- **db**: `user_model_credentials` table (1:1 with a user via a unique `user_id` FK, `onDelete: cascade`). Stores `api_key_ciphertext` (AES-256-GCM, packed `iv|tag|ciphertext`), `key_hint`, optional `base_url` and `default_model`. Migration `0001` adds the table. The encryption itself is owned by `apps/api` (`crypto.ts`); the DB only holds the ciphertext blob.

# AGENTS.md — pi-devin

Pi package that registers the `devin` provider. Auth and the model catalog come from the local Devin CLI. Pi remains the harness.

## Layout

```
extensions/index.ts   # registerProvider("devin"), /login, /devin-status, /devin-refresh
src/cli.ts            # locate + spawn `devin`
src/credentials.ts    # ~/.local/share/devin/credentials.toml
src/desktop-auth.ts   # reuse a Devin Desktop sign-in when the CLI store is missing
src/models.ts         # `devin models list --format json` → ProviderModelConfig[]
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history
```

## Contract

- `/login devin` must call `devin auth login` when no local credential exists. Reusing the session token a signed-in Devin Desktop already stores on disk is allowed; a custom paste/device flow is not.
- Model IDs must come from `devin models list`, not a hardcoded cloud allowlist.
- One pi model per Devin family: the id is the family slug and pi's thinking level picks the variant (`swe-2` + `max` → `swe-2-max`). Never bake a level into the model id.
- Levels a family does not ship must be `null` in `thinkingLevelMap`, so pi hides them instead of silently falling back.
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`.
